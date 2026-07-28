<script setup lang="ts">
import BookmarkletView from "@/views/BookmarkletView.vue";
import RemoteInputView from "@/views/RemoteInputView.vue";
import { isBookmarkletMode } from "@/utils/bookmarklet";

const bookmarkletMode = isBookmarkletMode();
</script>

<template>
  <BookmarkletView v-if="bookmarkletMode" />
  <RemoteInputView v-else />
</template>
