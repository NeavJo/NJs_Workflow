import { defineConfig } from 'vite'

/*
 * base 配置：
 * - 本地开发（vite dev）：'./' 相对路径，可工作
 * - GitHub Pages 部署：站点路径为 https://<用户名>.github.io/NJs_Workflow/，
 *   必须用绝对路径 '/NJs_Workflow/'，否则构建产物里 JS/CSS/字体引用的
 *   资源 URL 会缺前缀，fetch 的动态拼接也会失效。
 * 运行时通过 import.meta.env.BASE_URL 读取该值，保证与构建期一致。
 */
export default defineConfig({
  base: '/NJs_Workflow/',
  server: {
    host: 'localhost',
    port: 5173,
    open: true,
    https: false
  }
})
