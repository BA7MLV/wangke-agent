import { HashRouter, Route, Routes } from 'react-router-dom';
import Library from './pages/Library';
import Player from './pages/Player';
import Settings from './pages/Settings';
import { useMobileGlobals } from './utils/useMobile';

export default function App() {
  useMobileGlobals();
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/player/:id" element={<Player />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </HashRouter>
  );
}
