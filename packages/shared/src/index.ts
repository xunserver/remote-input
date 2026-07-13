export type ServerInfo = {
  port: number;
  lanAddresses: string[];
};

export type ClientMessage =
  | {
      type: "hello";
      deviceName?: string;
    }
  | {
      type: "input";
      requestId?: string;
      text?: string;
    };

export type ServerMessage =
  | {
      type: "connected";
      clientId: string;
      server: ServerInfo;
    }
  | {
      type: "ready";
      clientId: string;
      deviceName: string;
      server: ServerInfo;
    }
  | {
      type: "clients";
      count: number;
      devices: Array<{
        id: string;
        deviceName: string;
        remoteAddress?: string;
      }>;
    }
  | {
      type: "input-status";
      requestId: string;
      status: "queued" | "copying" | "pasting" | "done" | "failed";
      progress: number;
      message: string;
    }
  | {
      type: "error";
      message: string;
    };
