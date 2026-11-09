<script lang="ts">
  import type { BoardPanelProps } from '@draw/client';
  let { boardId, disabled }: BoardPanelProps = $props();
</script>

<p class="pinboard">Pinboard for board {boardId}{disabled ? ' (off)' : ''}</p>
