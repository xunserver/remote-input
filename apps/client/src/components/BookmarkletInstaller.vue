<script setup lang="ts">
import { computed, ref } from "vue";
import { Bookmark, Check, Copy } from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@shadcn/card";
import {
  createBookmarkletHref,
  getBookmarkletLoaderUrl,
} from "@/utils/bookmarklet";

const copied = ref(false);
const bookmarkletHref = computed(() =>
  createBookmarkletHref(getBookmarkletLoaderUrl()),
);

async function copyBookmarklet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(bookmarkletHref.value);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <Card class="shadow-sm">
    <CardHeader class="gap-1 px-4 sm:px-5">
      <CardTitle class="flex items-center gap-2 text-base">
        <Bookmark class="size-4" aria-hidden="true" />
        浏览器快速发送
      </CardTitle>
      <CardDescription>
        把按钮拖到书签栏。浏览网页时选中文字，再点击书签即可打开悬浮发送窗。
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-3 px-4 sm:flex-row sm:items-center sm:px-5">
      <Button as-child class="h-11 sm:min-w-44">
        <a
          :href="bookmarkletHref"
          title="拖动此按钮到浏览器书签栏"
        >
          <Bookmark data-icon="inline-start" aria-hidden="true" />
          快速发送选中文本
        </a>
      </Button>
      <Button variant="outline" class="h-11" @click="copyBookmarklet">
        <Check v-if="copied" data-icon="inline-start" aria-hidden="true" />
        <Copy v-else data-icon="inline-start" aria-hidden="true" />
        {{ copied ? "已复制脚本地址" : "复制脚本地址" }}
      </Button>
      <p class="text-xs leading-5 text-muted-foreground">
        书签只保存轻量启动器，界面和发送逻辑从 GitHub Pages 按需加载。
      </p>
    </CardContent>
  </Card>
</template>
