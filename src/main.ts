import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './ui/styles.css';
import { initAnalytics } from './analytics';
import { initI18n } from './i18n';
import { PcbApp } from './ui/app';

initAnalytics();

const mount = document.getElementById('app');
if (mount) {
  // the language's strings load before the UI is built (English needs nothing)
  void initI18n().then(() => {
    const app = new PcbApp(mount);
    void app.init();
  });
}
