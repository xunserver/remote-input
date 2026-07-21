<script setup lang="ts">
import { ref } from "vue";
import { Clock3, RotateCcw } from "@lucide/vue";
import { Badge } from "@shadcn/badge";
import { Button } from "@shadcn/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shadcn/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@shadcn/empty";
import type { HistoryItem } from "@/types/remote-input";

type InputHistoryProps = {
  history: HistoryItem[];
  canResend: boolean;
  onResend: (text: string) => Promise<boolean>;
  onClear: () => void;
};

const props = defineProps<InputHistoryProps>();
const resendInFlight = ref(false);

async function resend(text: string): Promise<void> {
  if (!props.canResend || resendInFlight.value) {
    return;
  }

  resendInFlight.value = true;
  try {
    await props.onResend(text);
  } finally {
    resendInFlight.value = false;
  }
}

function formatSentAt(sentAt: string): string {
  return new Date(sentAt).toLocaleString();
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-2 px-1 lg:min-h-8">
      <div class="flex items-center gap-2">
        <Clock3 class="text-muted-foreground" aria-hidden="true" />
        <h2 class="text-sm font-medium">最近发送</h2>
        <Badge v-if="props.history.length > 0" variant="secondary">
          {{ props.history.length }}
        </Badge>
      </div>
      <Button
        variant="ghost"
        size="sm"
        :disabled="props.history.length === 0"
        @click="props.onClear"
      >
        清空
      </Button>
    </div>

    <Empty v-if="props.history.length === 0" class="border">
      <EmptyHeader>
        <EmptyTitle>还没有发送记录</EmptyTitle>
        <EmptyDescription>成功提交的文字会保留在这里</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <div v-else class="flex flex-col gap-3">
      <Card
        v-for="item in props.history"
        :key="item.id"
        class="gap-2 py-4 shadow-xs"
      >
        <CardHeader class="px-4">
          <CardTitle
            class="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5"
          >
            {{ item.text }}
          </CardTitle>
        </CardHeader>
        <CardFooter class="items-center justify-between gap-3 px-4">
          <CardDescription class="min-w-0 text-xs">
            {{ formatSentAt(item.sentAt) }}
          </CardDescription>
          <Button
            variant="outline"
            size="sm"
            class="shrink-0"
            :disabled="!props.canResend || resendInFlight"
            @click="resend(item.text)"
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            重发
          </Button>
        </CardFooter>
      </Card>
    </div>
  </section>
</template>
