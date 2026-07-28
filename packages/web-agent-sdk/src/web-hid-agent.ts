import { RelayAgent, type HidChannel, type TextProcessor } from "./relay-agent.js";
import {
  KEYBOARD_USAGE,
  KEYBOARD_USAGE_PAGE,
} from "@remote-copy/device-protocol";

export const REMOTE_COPY_USB_VENDOR_ID = 0x303a;
export const REMOTE_COPY_USB_PRODUCT_ID = 0x4002;
export const REMOTE_COPY_HID_USAGE_PAGE = KEYBOARD_USAGE_PAGE;
export const REMOTE_COPY_HID_USAGE = KEYBOARD_USAGE;

export type WebHidAgentState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed";

export interface WebHidSupport {
  supported: boolean;
  reason?: "insecure_context" | "unsupported";
}

export interface HidDeviceFilterLike {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

export interface HidInputReportEventLike {
  readonly data: DataView;
  readonly device: HidDeviceLike;
  readonly reportId: number;
}

export interface HidConnectionEventLike {
  readonly device: HidDeviceLike;
}

export interface HidDeviceLike {
  readonly opened: boolean;
  readonly productId: number;
  readonly productName?: string;
  readonly vendorId: number;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(
    type: "inputreport",
    listener: (event: HidInputReportEventLike) => void,
  ): void;
  removeEventListener(
    type: "inputreport",
    listener: (event: HidInputReportEventLike) => void,
  ): void;
}

export interface HidNavigatorLike {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: {
    filters: HidDeviceFilterLike[];
  }): Promise<HidDeviceLike[]>;
  addEventListener(
    type: "connect" | "disconnect",
    listener: (event: HidConnectionEventLike) => void,
  ): void;
  removeEventListener(
    type: "connect" | "disconnect",
    listener: (event: HidConnectionEventLike) => void,
  ): void;
}

export interface WebHidEnvironment {
  readonly hid?: HidNavigatorLike;
  readonly isSecureContext?: boolean;
}

export interface WebHidAgentOptions {
  onText: TextProcessor;
  onError?: (error: unknown) => void;
  onStateChange?: (
    state: WebHidAgentState,
    device: HidDeviceLike | null,
  ) => void;
  environment?: WebHidEnvironment;
  filters?: HidDeviceFilterLike[];
}

const defaultFilters: HidDeviceFilterLike[] = [
  {
    vendorId: REMOTE_COPY_USB_VENDOR_ID,
    productId: REMOTE_COPY_USB_PRODUCT_ID,
    usagePage: REMOTE_COPY_HID_USAGE_PAGE,
    usage: REMOTE_COPY_HID_USAGE,
  },
];

export function getWebHidSupport(
  environment: WebHidEnvironment = browserEnvironment(),
): WebHidSupport {
  if (environment.isSecureContext === false) {
    return { supported: false, reason: "insecure_context" };
  }
  if (!environment.hid) {
    return { supported: false, reason: "unsupported" };
  }
  return { supported: true };
}

export class WebHidAgent {
  readonly #environment: WebHidEnvironment;
  readonly #filters: HidDeviceFilterLike[];
  readonly #onText: TextProcessor;
  readonly #onError: (error: unknown) => void;
  readonly #onStateChange: NonNullable<WebHidAgentOptions["onStateChange"]>;
  #device: HidDeviceLike | null = null;
  #relay: RelayAgent | null = null;
  #state: WebHidAgentState = "idle";
  #generation = 0;

  readonly #handleConnect = (event: HidConnectionEventLike): void => {
    if (this.#state === "closed" || !matchesFilters(event.device, this.#filters)) {
      return;
    }
    if (this.#state === "disconnected") {
      void this.openDevice(event.device).catch(this.#onError);
    }
  };

  readonly #handleDisconnect = (event: HidConnectionEventLike): void => {
    if (!this.#device || !sameDevice(this.#device, event.device)) return;
    this.#generation += 1;
    this.#relay?.close();
    this.#relay = null;
    this.#device = null;
    this.setState("disconnected");
  };

  constructor(options: WebHidAgentOptions) {
    this.#environment = options.environment ?? browserEnvironment();
    this.#filters = options.filters?.map((filter) => ({ ...filter })) ?? defaultFilters;
    this.#onText = options.onText;
    this.#onError = options.onError ?? console.error;
    this.#onStateChange = options.onStateChange ?? (() => undefined);
    this.#environment.hid?.addEventListener("connect", this.#handleConnect);
    this.#environment.hid?.addEventListener("disconnect", this.#handleDisconnect);
  }

  get state(): WebHidAgentState {
    return this.#state;
  }

  get device(): HidDeviceLike | null {
    return this.#device;
  }

  async connect(): Promise<void> {
    this.assertSupported();
    if (this.#state === "closed") throw new Error("WebHidAgent is closed.");
    if (this.#state === "connected" || this.#state === "connecting") return;
    this.setState("connecting");
    try {
      const devices = await this.#environment.hid!.requestDevice({
        filters: this.#filters,
      });
      const device = devices[0];
      if (!device) {
        this.setState("idle");
        return;
      }
      await this.openDevice(device);
    } catch (error) {
      this.setState("idle");
      throw error;
    }
  }

  async connectAuthorized(): Promise<boolean> {
    this.assertSupported();
    if (this.#state === "closed") return false;
    const devices = await this.#environment.hid!.getDevices();
    const device = devices.find((candidate) =>
      matchesFilters(candidate, this.#filters),
    );
    if (!device) return false;
    await this.openDevice(device);
    return true;
  }

  async disconnect(): Promise<void> {
    if (this.#state === "closed") return;
    const device = this.#device;
    this.#generation += 1;
    this.#relay?.close();
    this.#relay = null;
    this.#device = null;
    if (device?.opened) await device.close();
    this.setState("idle");
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    await this.disconnect();
    this.#environment.hid?.removeEventListener("connect", this.#handleConnect);
    this.#environment.hid?.removeEventListener("disconnect", this.#handleDisconnect);
    this.setState("closed");
  }

  private assertSupported(): void {
    const support = getWebHidSupport(this.#environment);
    if (!support.supported) {
      throw new Error(
        support.reason === "insecure_context"
          ? "WebHID requires HTTPS or localhost."
          : "WebHID is not supported by this browser.",
      );
    }
  }

  private async openDevice(device: HidDeviceLike): Promise<void> {
    const generation = ++this.#generation;
    this.setState("connecting");
    if (!device.opened) await device.open();
    if (generation !== this.#generation || this.#state === "closed") {
      if (device.opened) await device.close();
      return;
    }

    this.#relay?.close();
    this.#device = device;
    let dataListener: (report: Uint8Array) => void = () => undefined;
    const listener = (event: HidInputReportEventLike): void => {
      const bytes = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength,
      );
      dataListener(bytes);
    };
    const channel: HidChannel = {
      onData: (nextListener) => {
        dataListener = nextListener;
        device.addEventListener("inputreport", listener);
        return () => device.removeEventListener("inputreport", listener);
      },
    };
    this.#relay = new RelayAgent(channel, this.#onText, this.#onError);
    this.setState("connected", device);
  }

  private setState(
    state: WebHidAgentState,
    device: HidDeviceLike | null = this.#device,
  ): void {
    if (this.#state === state && this.#device === device) return;
    this.#state = state;
    this.#onStateChange(state, device);
  }
}

function browserEnvironment(): WebHidEnvironment {
  const browserNavigator = globalThis.navigator as
    | (Navigator & { hid?: HidNavigatorLike })
    | undefined;
  const hid = browserNavigator?.hid;
  return {
    ...(hid ? { hid } : {}),
    isSecureContext: globalThis.isSecureContext,
  };
}

function matchesFilters(
  device: HidDeviceLike,
  filters: HidDeviceFilterLike[],
): boolean {
  return filters.some(
    (filter) =>
      (filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
      (filter.productId === undefined || filter.productId === device.productId),
  );
}

function sameDevice(left: HidDeviceLike, right: HidDeviceLike): boolean {
  return (
    left === right ||
    (left.vendorId === right.vendorId &&
      left.productId === right.productId &&
      left.productName === right.productName)
  );
}
