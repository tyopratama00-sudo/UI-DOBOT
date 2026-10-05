import { createRoot } from 'react-dom/client';
import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@photobooth/ui/prototype.css';
import './styles/booth.css';
import { App } from './App';
import { installKioskGuards, captureDeviceKey } from './kiosk';

captureDeviceKey();
installKioskGuards();

createRoot(document.getElementById('root')!).render(<App />);
