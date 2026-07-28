import CoreBluetooth
import Foundation

private let serviceId = CBUUID(string: "7C6B0001-6D5A-4F4F-9D2D-5F6F74656368")
private let writeId = CBUUID(string: "7C6B0002-6D5A-4F4F-9D2D-5F6F74656368")
private let relayPayloadBytes = 48

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

private func relayFrames(text: String) throws -> [Data] {
    let message: [String: Any] = [
        "type": "request",
        "requestId": 1,
        "method": "sendText",
        "payload": ["text": text],
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

private final class UplinkSender: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var frames: [Data]
    private var nextFrame = 0

    init(text: String) throws {
        frames = try relayFrames(text: text)
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            fputs("Timed out waiting for ESP32-S3 BLE uplink.\n", stderr)
            exit(2)
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state != .unknown && central.state != .resetting {
                fputs("Bluetooth is unavailable: \(central.state.rawValue)\n", stderr)
                exit(2)
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
        guard peripheral.name == "Remote Copy ESP32-S3" ||
              advertisementData[CBAdvertisementDataLocalNameKey] as? String == "Remote Copy ESP32-S3"
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
        peripheral.discoverCharacteristics([writeId], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        if let error { fail(error) }
        guard let characteristic = service.characteristics?.first(where: { $0.uuid == writeId }) else {
            failMessage("Relay write characteristic was not found.")
        }
        writeCharacteristic = characteristic
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

    private func writeNext(_ peripheral: CBPeripheral) {
        guard nextFrame < frames.count else {
            print("Sent \(frames.count) validated relay frame(s) over BLE.")
            central.cancelPeripheralConnection(peripheral)
            exit(0)
        }
        let frame = frames[nextFrame]
        nextFrame += 1
        peripheral.writeValue(frame, for: writeCharacteristic!, type: .withResponse)
    }

    private func fail(_ error: Error) -> Never {
        failMessage(error.localizedDescription)
    }

    private func failMessage(_ message: String) -> Never {
        fputs("\(message)\n", stderr)
        exit(2)
    }
}

private let text = CommandLine.arguments.dropFirst().first ?? "标准键盘 HID 上行测试：中文与 emoji 🙂"
private let sender = try UplinkSender(text: text)
withExtendedLifetime(sender) {
    RunLoop.main.run()
}
