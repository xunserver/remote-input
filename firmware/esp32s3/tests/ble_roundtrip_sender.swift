import CoreBluetooth
import Foundation

private let serviceId = CBUUID(string: "7C6B0001-6D5A-4F4F-9D2D-5F6F74656368")
private let writeId = CBUUID(string: "7C6B0002-6D5A-4F4F-9D2D-5F6F74656368")
private let notifyId = CBUUID(string: "7C6B0003-6D5A-4F4F-9D2D-5F6F74656368")
private let relayPayloadBytes = 48
private let operationId = "ble-roundtrip-\(UUID().uuidString)"

private func crc16Ccitt(_ data: Data) -> UInt16 {
    var crc: UInt16 = 0xffff
    for byte in data {
        crc ^= UInt16(byte) << 8
        for _ in 0..<8 {
            crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1
        }
    }
    return crc
}

private func appendLE<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

private func readLE<T: FixedWidthInteger>(_ type: T.Type, from data: Data, at offset: Int) -> T {
    data.subdata(in: offset..<(offset + MemoryLayout<T>.size))
        .withUnsafeBytes { $0.loadUnaligned(as: T.self) }
        .littleEndian
}

private func relayFrames(text: String, paste: Bool) throws -> [Data] {
    let message: [String: Any] = [
        "type": "notify",
        "method": "sendText",
        "payload": [
            "operationId": operationId,
            "text": text,
            "control": ["paste": paste, "restoreClipboard": paste],
        ],
    ]
    let bytes = try JSONSerialization.data(withJSONObject: message)
    let chunkCount = max(1, (bytes.count + relayPayloadBytes - 1) / relayPayloadBytes)
    let transferId = UInt32(Date().timeIntervalSince1970) | 1
    return (0..<chunkCount).map { index in
        let start = index * relayPayloadBytes
        let end = min(bytes.count, start + relayPayloadBytes)
        let payload = bytes.subdata(in: start..<end)
        var frame = Data()
        appendLE(UInt16(0x5243), to: &frame)
        frame.append(2)
        frame.append(0)
        appendLE(transferId, to: &frame)
        appendLE(UInt16(index), to: &frame)
        appendLE(UInt16(chunkCount), to: &frame)
        appendLE(UInt16(payload.count), to: &frame)
        appendLE(crc16Ccitt(payload), to: &frame)
        frame.append(payload)
        return frame
    }
}

private final class RoundTripSender: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBCharacteristic?
    private var frames: [Data]
    private var nextFrame = 0
    private var responseTransferId: UInt32?
    private var responseChunkCount = 0
    private var responseChunks: [Int: Data] = [:]

    init(text: String, paste: Bool) throws {
        frames = try relayFrames(text: text, paste: paste)
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            fputs("Timed out waiting for the terminal BLE inputStatus notification.\n", stderr)
            exit(2)
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state != .unknown && central.state != .resetting {
                failMessage("Bluetooth is unavailable: \(central.state.rawValue)")
            }
            return
        }
        central.scanForPeripherals(withServices: [serviceId])
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard peripheral.name == "Remote Input ESP32-S3" ||
              advertisementData[CBAdvertisementDataLocalNameKey] as? String == "Remote Input ESP32-S3"
        else { return }
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([serviceId])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { fail(error) }
        guard let service = peripheral.services?.first(where: { $0.uuid == serviceId }) else {
            failMessage("Relay service was not found.")
        }
        peripheral.discoverCharacteristics([writeId, notifyId], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error { fail(error) }
        writeCharacteristic = service.characteristics?.first(where: { $0.uuid == writeId })
        notifyCharacteristic = service.characteristics?.first(where: { $0.uuid == notifyId })
        guard writeCharacteristic != nil, let notifyCharacteristic else {
            failMessage("Relay write or notify characteristic was not found.")
        }
        peripheral.setNotifyValue(true, for: notifyCharacteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error { fail(error) }
        guard characteristic.uuid == notifyId, characteristic.isNotifying else {
            failMessage("Relay notifications could not be enabled.")
        }
        writeNext(peripheral)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error { fail(error) }
        writeNext(peripheral)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        if let error { fail(error) }
        guard characteristic.uuid == notifyId, let value = characteristic.value else { return }
        acceptNotification(value)
    }

    private func writeNext(_ peripheral: CBPeripheral) {
        guard nextFrame < frames.count else { return }
        let frame = frames[nextFrame]
        nextFrame += 1
        peripheral.writeValue(frame, for: writeCharacteristic!, type: .withResponse)
    }

    private func acceptNotification(_ frame: Data) {
        guard frame.count >= 16,
              readLE(UInt16.self, from: frame, at: 0) == 0x5243,
              frame[2] == 2
        else { failMessage("Received an invalid relay frame header.") }
        let transferId = readLE(UInt32.self, from: frame, at: 4)
        let chunkIndex = Int(readLE(UInt16.self, from: frame, at: 8))
        let chunkCount = Int(readLE(UInt16.self, from: frame, at: 10))
        let payloadLength = Int(readLE(UInt16.self, from: frame, at: 12))
        guard chunkCount > 0, chunkIndex < chunkCount, frame.count >= 16 + payloadLength else {
            failMessage("Received an invalid relay frame length.")
        }
        let payload = frame.subdata(in: 16..<(16 + payloadLength))
        guard readLE(UInt16.self, from: frame, at: 14) == crc16Ccitt(payload) else {
            failMessage("Received a relay frame with an invalid CRC.")
        }
        if responseTransferId != transferId {
            responseTransferId = transferId
            responseChunkCount = chunkCount
            responseChunks.removeAll()
        }
        guard responseChunkCount == chunkCount else {
            failMessage("Relay chunk count changed during a transfer.")
        }
        responseChunks[chunkIndex] = payload
        guard responseChunks.count == chunkCount else { return }
        var complete = Data()
        for index in 0..<chunkCount {
            guard let chunk = responseChunks[index] else { return }
            complete.append(chunk)
        }
        responseTransferId = nil
        responseChunks.removeAll()
        acceptMessage(complete)
    }

    private func acceptMessage(_ data: Data) {
        guard
            let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            message["type"] as? String == "notify",
            message["method"] as? String == "inputStatus",
            let payload = message["payload"] as? [String: Any],
            payload["operationId"] as? String == operationId,
            let stage = payload["stage"] as? String
        else { failMessage("Received an invalid inputStatus notification.") }
        print("Received inputStatus stage: \(stage)")
        if stage == "succeeded" {
            print("BLE -> USB HID -> Agent -> USB HID -> BLE round trip succeeded.")
            if let peripheral { central.cancelPeripheralConnection(peripheral) }
            exit(0)
        }
        if stage == "failed" {
            failMessage(payload["message"] as? String ?? "The receiver reported a failure.")
        }
    }

    private func fail(_ error: Error) -> Never {
        failMessage(error.localizedDescription)
    }

    private func failMessage(_ message: String) -> Never {
        fputs("\(message)\n", stderr)
        exit(2)
    }
}

private let arguments = Array(CommandLine.arguments.dropFirst())
private let paste = arguments.contains("--paste")
private let text = arguments.first(where: { $0 != "--paste" }) ?? "BLE round-trip test: 中文与 emoji 🙂"
private let sender = try RoundTripSender(text: text, paste: paste)
withExtendedLifetime(sender) {
    RunLoop.main.run()
}
