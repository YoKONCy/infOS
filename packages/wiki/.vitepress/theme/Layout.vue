<template>
  <DefaultTheme.Layout>
    <template #nav-bar-content-after>
      <GitHubStars />
    </template>
    <template #aside-bottom>
      <ReadingBuddy />
    </template>
    <template #not-found>
      <NotFound />
    </template>
  </DefaultTheme.Layout>
</template>

<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import GitHubStars from '../components/GitHubStars.vue'
import ReadingBuddy from '../components/ReadingBuddy.vue'
import NotFound from '../components/NotFound.vue'
</script>
