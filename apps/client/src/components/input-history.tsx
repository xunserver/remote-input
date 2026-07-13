import { Badge } from "@shadcn/badge";
import { Button } from "@shadcn/button";
import { Card, CardContent } from "@shadcn/card";
import { Progress } from "@shadcn/progress";
import { statusLabel, type HistoryItem } from "@/types/remote-input";

type InputHistoryProps = {
  history: HistoryItem[];
  onClear: () => void;
};

export function InputHistory({ history, onClear }: InputHistoryProps) {
  return (
    <section className="flex flex-col gap-2 pb-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-medium">输入历史</h2>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={history.length === 0}>
          清空
        </Button>
      </div>
      {history.length === 0 ? (
        <Card className="rounded-lg shadow-sm">
          <CardContent className="p-4 text-sm text-muted-foreground">暂无输入历史。</CardContent>
        </Card>
      ) : (
        history.map((item) => (
          <Card key={item.id} className="rounded-lg shadow-sm">
            <CardContent className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
                  {statusLabel(item.status, item.stage)}
                </Badge>
                <span className="text-xs text-muted-foreground">{new Date(item.sentAt).toLocaleString()}</span>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">{item.text}</p>
              <Progress value={item.progress} />
              <p className="text-xs text-muted-foreground">{item.message}</p>
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}
