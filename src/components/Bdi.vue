<template>
  <bdi class="unicode-isolate" dir="ltr"><slot>{{ value }}</slot></bdi>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'Bdi',
  props: {
    value: {
      type: [String, Number],
      default: '',
    },
  },
});
</script>

<style scoped>
.unicode-isolate {
  unicode-bidi: isolate;
}
</style>
