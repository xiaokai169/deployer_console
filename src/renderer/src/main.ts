import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'

// 在挂载前应用主题，避免启动闪白/闪黑
document.documentElement.dataset.theme = localStorage.getItem('deploye-theme') || 'forest'

createApp(App).use(createPinia()).mount('#app')
