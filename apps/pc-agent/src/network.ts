import os from "node:os";

export function getLanAddresses(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  return [...new Set(addresses)].sort();
}
