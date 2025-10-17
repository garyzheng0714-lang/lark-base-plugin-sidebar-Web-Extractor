<script setup>
  import { ref } from 'vue';
  import Form from './views/Form.vue';
  import Hierarchy from './views/Hierarchy.vue';
  const activeTab = ref('form');
  const tabs = [
    { name: 'form', label: '正文提取' },
    { name: 'hierarchy', label: '榜单层级提取' },
  ];
</script>

<template>
  <main>
    <el-tabs v-model="activeTab" type="card">
      <el-tab-pane label="正文提取" name="form">
        <Form />
      </el-tab-pane>
      <el-tab-pane label="榜单层级提取" name="hierarchy">
        <Hierarchy :active="activeTab === 'hierarchy'" />
      </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style scoped>
  main {
    padding: 1rem;
  }
</style>
