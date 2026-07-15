import { useCallback, useState } from "react";
import { Loader2, SendHorizonal } from "lucide-react";
import { Button } from "@shadcn/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@shadcn/card";
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
    <Card className="gap-0 overflow-hidden py-0 shadow-sm">
      <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="text-base">发送文字</CardTitle>
          <CardDescription>{mode === "single" ? "按 Enter 立即发送" : "支持换行，点击按钮发送"}</CardDescription>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          多行
          <Switch
            aria-label="切换多行输入"
            checked={mode === "multi"}
            onCheckedChange={(checked) => setMode(checked ? "multi" : "single")}
          />
        </label>
      </CardHeader>

      <CardContent className="px-4 pb-4 sm:px-5">
        <Textarea
          autoFocus
          value={text}
          enterKeyHint={mode === "single" ? "send" : "enter"}
          placeholder={isReady ? "在这里输入或粘贴文字…" : "连接服务器后即可输入"}
          disabled={!isReady || isBusy}
          className="min-h-44 resize-none border-0 bg-muted/60 p-4 text-base shadow-none focus-visible:bg-background focus-visible:ring-2 sm:min-h-56"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (mode === "single" && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </CardContent>

      <CardFooter className="flex-col gap-3 border-t bg-muted/20 px-4 py-3 sm:flex-row sm:justify-between sm:px-5">
        <p className="w-full text-xs text-muted-foreground sm:w-auto">
          {isReady ? `${text.length.toLocaleString()} 个字符` : "请先完成服务器连接"}
        </p>
        <Button size="lg" className="h-12 w-full sm:w-auto sm:min-w-32" disabled={!canSend} onClick={() => void send()}>
          {isBusy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <SendHorizonal data-icon="inline-start" />}
          {isBusy ? "发送中" : "发送"}
        </Button>
      </CardFooter>
    </Card>
  );
}
