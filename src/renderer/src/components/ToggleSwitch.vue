<script setup lang="ts">
defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()
</script>

<template>
  <div class="switch" :class="{ on: modelValue }" @click="emit('update:modelValue', !modelValue)"></div>
</template>
