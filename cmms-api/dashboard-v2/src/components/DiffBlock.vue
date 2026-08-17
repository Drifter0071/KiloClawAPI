<script setup lang="ts">
// TODO(follow-up): when /api/diff returns a real diff, split on /^[-+]/m and colorize.
withDefaults(
  defineProps<{
    before?: string | null
    after: string
  }>(),
  {
    before: null,
  },
)
</script>

<template>
  <div>
    <div
      v-if="before != null"
      class="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1"
      data-testid="diff-block-header"
    >
      előtte → utána
    </div>
    <pre
      class="bg-canvas-2 border border-border-subtle rounded-md p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text-secondary"
      data-testid="diff-block-pre"
    >{{ after }}</pre>
  </div>
</template>
