(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.RemoteInput = {}));
})(this, (function (exports) { 'use strict';

    const SERVICE_UUID = "9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001";
    const CONTROL_UUID = "9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001";
    const DATA_UUID = "9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001";
    const STATUS_UUID = "9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001";
    const VERSION = 1;
    const CONTROL_START = 1;
    const CONTROL_COMMIT = 2;
    const DATA_FRAME = 16;
    const MAX_TEXT_BYTES = 16 * 1024;
    const DATA_PAYLOAD_BYTES = 12;
    const STATES = ["idle", "receiving", "typing", "done", "error"];

    class RemoteInputError extends Error {
        constructor(code, message, cause) {
            super(message);
            this.name = "RemoteInputError";
            this.code = code;
            if (cause !== undefined) {
                this.cause = cause;
            }
        }
        toString() {
            return `${this.name} [${this.code}]: ${this.message}`;
        }
    }
    function getErrorName(error) {
        if (typeof error === "object" && error !== null && "name" in error) {
            const name = error.name;
            return typeof name === "string" ? name : undefined;
        }
        return undefined;
    }
    function getErrorMessage(error, fallback) {
        if (typeof error === "object" && error !== null && "message" in error) {
            const message = error.message;
            return typeof message === "string" && message.length > 0 ? message : fallback;
        }
        return fallback;
    }

    function encodeControlFrame(type, taskId, totalBytes, totalChunks) {
        const frame = new ArrayBuffer(12);
        const view = new DataView(frame);
        view.setUint8(0, VERSION);
        view.setUint8(1, type);
        view.setUint16(2, taskId, true);
        view.setUint32(4, totalBytes, true);
        view.setUint16(8, totalChunks, true);
        view.setUint16(10, 0, true);
        return new Uint8Array(frame);
    }
    function createDataFrames(taskId, bytes) {
        const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / DATA_PAYLOAD_BYTES));
        const frames = [];
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
            const start = chunkIndex * DATA_PAYLOAD_BYTES;
            const payload = bytes.slice(start, start + DATA_PAYLOAD_BYTES);
            const frame = new Uint8Array(8 + payload.byteLength);
            const view = new DataView(frame.buffer);
            view.setUint8(0, VERSION);
            view.setUint8(1, DATA_FRAME);
            view.setUint16(2, taskId, true);
            view.setUint16(4, chunkIndex, true);
            view.setUint16(6, totalChunks, true);
            frame.set(payload, 8);
            frames.push(frame);
        }
        return frames;
    }
    function createStatusObject() {
        const maybeWindow = globalThis.window;
        if (maybeWindow?.constructor?.name === "Object") {
            return new maybeWindow.constructor();
        }
        return {};
    }
    function decodeStatusFrame(buffer) {
        const view = buffer instanceof DataView ? buffer : new DataView(buffer);
        if (view.byteLength !== 14 || view.getUint8(0) !== VERSION) {
            throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
        }
        const stateCode = view.getUint8(1);
        if (stateCode >= STATES.length) {
            throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
        }
        const status = createStatusObject();
        status.state = STATES[stateCode];
        status.lastTaskId = view.getUint16(2, true);
        status.lastErrorCode = view.getUint16(4, true);
        status.receivedBytes = view.getUint32(6, true);
        status.totalBytes = view.getUint32(10, true);
        return status;
    }
    function assertTextSize(bytes) {
        if (bytes.byteLength > MAX_TEXT_BYTES) {
            throw new RemoteInputError("TEXT_TOO_LARGE", "Text exceeds 16 KB UTF-8 limit");
        }
    }
    const constants = {
        VERSION,
        SERVICE_UUID,
        CONTROL_UUID,
        DATA_UUID,
        STATUS_UUID,
        CONTROL_START,
        CONTROL_COMMIT,
        DATA_FRAME,
        MAX_TEXT_BYTES,
        DATA_PAYLOAD_BYTES,
    };

    class RemoteInputDevice {
        constructor(device, server, controlChar, dataChar, statusChar) {
            this.taskId = 1;
            this.pending = null;
            this.connected = true;
            this.statusNotificationsStarted = false;
            this.device = device;
            this.server = server;
            this.controlChar = controlChar;
            this.dataChar = dataChar;
            this.statusChar = statusChar;
            this.onDisconnected = this.onDisconnected.bind(this);
            this.onStatusChanged = this.onStatusChanged.bind(this);
            this.device.addEventListener("gattserverdisconnected", this.onDisconnected);
        }
        async startNotifications() {
            await this.statusChar.startNotifications();
            this.statusNotificationsStarted = true;
            this.statusChar.addEventListener("characteristicvaluechanged", this.onStatusChanged);
        }
        typeText(text) {
            if (!this.connected) {
                return Promise.reject(new RemoteInputError("NOT_CONNECTED", "Device is not connected"));
            }
            if (this.pending) {
                return Promise.reject(new RemoteInputError("CLIENT_BUSY", "A typeText call is already pending"));
            }
            const bytes = new TextEncoder().encode(text);
            try {
                assertTextSize(bytes);
            }
            catch (error) {
                return Promise.reject(error);
            }
            const taskId = this.taskId;
            this.taskId = (this.taskId % 65535) + 1;
            const frames = createDataFrames(taskId, bytes);
            const startFrame = encodeControlFrame(CONTROL_START, taskId, bytes.byteLength, frames.length);
            const commitFrame = encodeControlFrame(CONTROL_COMMIT, taskId, bytes.byteLength, frames.length);
            const completion = new Promise((resolve, reject) => {
                this.pending = { taskId, resolve, reject };
            });
            void this.pumpWrites(taskId, startFrame, frames, commitFrame);
            return completion;
        }
        async getStatus() {
            if (!this.connected) {
                throw new RemoteInputError("NOT_CONNECTED", "Device is not connected");
            }
            const value = await this.statusChar.readValue();
            return decodeStatusFrame(value);
        }
        async disconnect() {
            this.connected = false;
            this.rejectPending("DISCONNECTED", "Device disconnected");
            try {
                this.statusChar.removeEventListener("characteristicvaluechanged", this.onStatusChanged);
                if (this.statusNotificationsStarted && this.statusChar.stopNotifications) {
                    await this.statusChar.stopNotifications();
                    this.statusNotificationsStarted = false;
                }
            }
            catch {
                // Ignore cleanup errors during disconnect.
            }
            this.device.removeEventListener("gattserverdisconnected", this.onDisconnected);
            if (this.device.gatt?.connected) {
                this.device.gatt.disconnect();
            }
        }
        async pumpWrites(taskId, startFrame, frames, commitFrame) {
            try {
                await this.controlChar.writeValueWithResponse(startFrame);
                if (!this.hasPendingTask(taskId))
                    return;
                for (const frame of frames) {
                    await this.dataChar.writeValueWithResponse(frame);
                    if (!this.hasPendingTask(taskId))
                        return;
                }
                if (!this.hasPendingTask(taskId))
                    return;
                await this.controlChar.writeValueWithResponse(commitFrame);
            }
            catch (error) {
                if (this.pending?.taskId === taskId) {
                    this.rejectPending("BLE_WRITE_FAILED", getErrorMessage(error, "BLE write failed"), error);
                }
            }
        }
        onStatusChanged(event) {
            let status;
            try {
                const target = event.target;
                if (!target?.value) {
                    throw new RemoteInputError("INVALID_STATUS_FRAME", "Invalid status frame");
                }
                status = decodeStatusFrame(target.value);
            }
            catch (error) {
                if (this.pending) {
                    this.rejectPending("INVALID_STATUS_FRAME", getErrorMessage(error, "Invalid status frame"), error);
                }
                return;
            }
            if (!this.pending || status.lastTaskId !== this.pending.taskId) {
                return;
            }
            if (status.state === "done") {
                const pending = this.pending;
                this.pending = null;
                pending.resolve(status);
                return;
            }
            if (status.state === "error") {
                this.rejectPending(`DEVICE_ERROR_${status.lastErrorCode}`, "Device returned an error");
            }
        }
        hasPendingTask(taskId) {
            return this.pending !== null && this.pending.taskId === taskId;
        }
        onDisconnected() {
            this.connected = false;
            this.rejectPending("DISCONNECTED", "Device disconnected");
        }
        rejectPending(code, message, cause) {
            if (!this.pending) {
                return;
            }
            const pending = this.pending;
            this.pending = null;
            pending.reject(new RemoteInputError(code, message, cause));
        }
    }

    async function connect() {
        const remoteNavigator = navigator;
        if (!remoteNavigator.bluetooth) {
            throw new RemoteInputError("WEB_BLUETOOTH_UNSUPPORTED", "Web Bluetooth is not available");
        }
        let device;
        try {
            device = await remoteNavigator.bluetooth.requestDevice({
                filters: [{ services: [SERVICE_UUID] }],
                optionalServices: [SERVICE_UUID],
            });
        }
        catch (error) {
            if (getErrorName(error) === "NotFoundError") {
                throw new RemoteInputError("DEVICE_SELECTION_CANCELLED", getErrorMessage(error, "Device selection cancelled"), error);
            }
            throw new RemoteInputError("DEVICE_REQUEST_FAILED", getErrorMessage(error, "Device request failed"), error);
        }
        let remoteDevice = null;
        try {
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            const controlChar = await service.getCharacteristic(CONTROL_UUID);
            const dataChar = await service.getCharacteristic(DATA_UUID);
            const statusChar = await service.getCharacteristic(STATUS_UUID);
            remoteDevice = new RemoteInputDevice(device, server, controlChar, dataChar, statusChar);
            await remoteDevice.startNotifications();
            return remoteDevice;
        }
        catch (error) {
            if (remoteDevice) {
                await remoteDevice.disconnect();
            }
            else if (device.gatt?.connected) {
                device.gatt.disconnect();
            }
            throw error;
        }
    }

    const _internals = {
        encodeControlFrame,
        createDataFrames,
        decodeStatusFrame,
        assertTextSize,
        constants,
    };
    const RemoteInput = {
        connect,
        RemoteInputError,
        RemoteInputDevice,
        _internals,
    };

    exports.RemoteInput = RemoteInput;
    exports.RemoteInputDevice = RemoteInputDevice;
    exports.RemoteInputError = RemoteInputError;
    exports._internals = _internals;
    exports.connect = connect;

}));
