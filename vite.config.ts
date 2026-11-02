import { defineConfig } from 'vite';

export default defineConfig({
  // Esta línea es la que necesitas para GitHub Pages
  base: './', 
  
  // Estas configuraciones deben mantenerse para que todo siga funcionando aquí
  server: { 
    allowedHosts: true, 
    hmr: process.env.DISABLE_HMR !== 'true', 
    watch: process.env.DISABLE_HMR === 'true' ? null : {} 
  },
  preview: { 
    allowedHosts: true 
  }
});
