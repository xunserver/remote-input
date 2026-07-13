import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";

export default function App() {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <section className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-4 p-4">
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle>远程输入</CardTitle>
              <CardDescription>Vite + React + Tailwind + shadcn 前端骨架已就绪。</CardDescription>
            </div>
            <Badge variant="secondary">未连接</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Progress value={0} />
            <p className="text-sm text-muted-foreground">后续会把 WebSocket 连接、发送进度和历史记录迁移到 React 状态中。</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>输入内容</CardTitle>
            <CardDescription>当前是框架占位页面，下一步迁移完整远程输入交互。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea className="min-h-[42vh] resize-y text-base" placeholder="后续会把现有远程输入逻辑迁移到 React 组件中。" />
            <div className="flex gap-2">
              <Button>发送</Button>
              <Button variant="outline">清空</Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
