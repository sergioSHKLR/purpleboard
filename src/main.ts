import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './ui/styles.css';
import { PcbApp } from './ui/app';

const mount = document.getElementById('app');
if (mount) {
  const app = new PcbApp(mount);
  void app.init();
}
