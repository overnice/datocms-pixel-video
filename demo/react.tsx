import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PixelVideo, PRESETS, type PresetName } from '../src/react';
import eyesWebm from './eyes.webm?url';
import eyesMp4 from './eyes.mp4?url';

function App() {
  const [preset, setPreset] = useState<PresetName | undefined>();
  const [paused, setPaused] = useState(false);
  return (
    <>
      <h1>&lt;PixelVideo /&gt;</h1>
      <p>
        <a href="./index.html">← Web component version</a>
      </p>
      <p className="controls">
        <button onClick={() => setPreset(undefined)} aria-pressed={!preset}>
          Defaults
        </button>
        {(Object.keys(PRESETS) as PresetName[]).map((name) => (
          <button key={name} onClick={() => setPreset(name)} aria-pressed={preset === name}>
            {name}
          </button>
        ))}
        <button onClick={() => setPaused(!paused)}>{paused ? 'Play' : 'Pause'}</button>
      </p>
      <PixelVideo
        className="demo-video"
        src={[eyesWebm, eyesMp4]}
        preset={preset}
        paused={paused}
        settings={{ hoverRadius: 200 }}
        onError={(message) => console.warn(message)}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
