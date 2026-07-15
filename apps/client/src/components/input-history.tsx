import { Clock3, RotateCcw } from "lucide-react";
import { Badge } from "@shadcn/badge";
import { Button } from "@shadcn/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@shadcn/card";
import type { HistoryItem } from "@/types/remote-input";

type InputHistoryProps = {
  history: HistoryItem[];
  canResend: boolean;
  onResend: (text: string) => Promise<boolean>;
  onClear: () => void;
};

export function InputHistory({ history, canResend, onResend, onClear }: InputHistoryProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-1 lg:min-h-8">
        <div className="flex items-center gap-2">
          <Clock3 className="text-muted-foreground" />
          <h2 className="text-sm font-medium">最近发送</h2>
          {history.length > 0 ? <Badge variant="secondary">{history.length}</Badge> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={history.length === 0}>
          清空
        </Button>
      </div>
      {history.length === 0 ? (
        <Card className="gap-0 border-dashed py-0 shadow-none">
          <CardHeader className="items-center px-4 pt-6 pb-2 text-center">
            <CardTitle className="text-sm">还没有发送记录</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-6 text-center">
            <CardDescription>成功提交的文字会保留在这里</CardDescription>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {history.map((item) => (
            <Card key={item.id} className="gap-2 py-4 shadow-xs">
              <CardHeader className="px-4">
                <CardTitle className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5">{item.text}</CardTitle>
              </CardHeader>
              <CardFooter className="items-center justify-between gap-3 px-4">
                <CardDescription className="min-w-0 text-xs">{new Date(item.sentAt).toLocaleString()}</CardDescription>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={!canResend}
                  onClick={() => void onResend(item.text)}
                >
                  <RotateCcw data-icon="inline-start" />
                  重发
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
