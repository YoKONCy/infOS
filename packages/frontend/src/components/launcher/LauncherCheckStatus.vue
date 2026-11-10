<script setup lang="ts">
import { launcherCheckLabel, type CheckItem } from '../../composables/launcher/launcherChecks'
defineProps<{ item: CheckItem }>()
</script>

<template>
  <strong>{{ launcherCheckLabel(item) }}</strong>
</template>
