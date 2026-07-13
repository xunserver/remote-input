import { useCallback, useState } from "react";
import { Loader2, SendHorizonal } from "lucide-react";
import { Button } from "@shadcn/button";
import { Card, CardContent } from "@shadcn/card";
import { Input } from "@shadcn/input";
import { Switch } from "@shadcn/switch";
import { Textarea } from "@shadcn/textarea";
import type { ConnectionState } from "@/types/remote-input";

type InputMode = "single" | "multi";

type InputComposerProps = {
  connectionState: ConnectionState;
  isBusy: boolean;
  onSend: (text: string) => Promise<boolean>;
};

export function InputComposer({ connectionState, isBusy, onSend }: InputComposerProps) {
  const [mode, setMode] = useState<InputMode>("single");
  const [text, setText] = useState("");
  const isReady = connectionState === "ready";
  const canSend = isReady && text.trim().length > 0 && !isBusy;

  const send = useCallback(async () => {
    if (await onSend(text)) {
      setText("");
    }
  }, [onSend, text]);

  return (
    <Card className="flex flex-1 rounded-lg shadow-sm">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">输入内容</span>
            <span className="text-xs text-muted-foreground">
              {mode === "single" ? "单行模式按 Enter 发送" : "多行模式 Enter 换行"}
            </span>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            多行
            <Switch
              aria-label="切换多行输入"
              checked={mode === "multi"}
              onCheckedChange={(checked) => setMode(checked ? "multi" : "single")}
            />
          </label>
        </div>

        {mode === "single" ? (
          <Input
            autoFocus
            value={text}
            enterKeyHint="send"
            placeholder={isReady ? "输入后按 Enter 发送" : "连接服务器后即可输入"}
            disabled={!isReady || isBusy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
        ) : (
          <Textarea
            value={text}
            placeholder={isReady ? "输入多行内容，点击发送按钮提交" : "连接服务器后即可输入"}
            disabled={!isReady || isBusy}
            className="min-h-[34svh] flex-1 resize-none text-base"
            onChange={(event) => setText(event.target.value)}
          />
        )}

        <Button size="lg" className="h-12 w-full" disabled={!canSend} onClick={() => void send()}>
          {isBusy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <SendHorizonal data-icon="inline-start" />}
          {isBusy ? "发送中" : "发送"}
        </Button>
      </CardContent>
    </Card>
  );
}
