import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PixelVideo, type PixelVideoSettings } from '../src/react';
import eyesWebm from './eyes.webm?url';
import eyesMp4 from './eyes.mp4?url';

// Looks built from DatoCMS palette tokens, as the lab's snippets give them.
const looks: Record<string, Partial<PixelVideoSettings>> = {
  Orange: {},
  Purple: {
    bgFill: 'var(--color-purple-light-5, #9e8ef5)',
    midFill: 'var(--color-purple-light-5, #9e8ef5)',
    highFill: 'var(--color-purple-light-0, #f6f5ff)',
    highStroke: 'var(--color-purple-light-2, #9e8ef580)',
  },
  Green: {
    bgFill: 'var(--color-green-deep-5, #1a4731)',
    midFill: 'var(--color-green-light-5, #9ad162)',
    highFill: 'var(--color-green-light-0, #f5fff5)',
    highStroke: 'var(--color-green-deep-1, #1a47311f)',
  },
};

function App() {
  const [look, setLook] = useState('Orange');
  const [paused, setPaused] = useState(false);
  return (
    <>
      <h1>&lt;PixelVideo /&gt;</h1>
      <p>
        <a href="./index.html">← Web component version</a>
      </p>
      <p className="controls">
        {Object.keys(looks).map((name) => (
          <button key={name} onClick={() => setLook(name)} aria-pressed={look === name}>
            {name}
          </button>
        ))}
        <button onClick={() => setPaused(!paused)}>{paused ? 'Play' : 'Pause'}</button>
      </p>
      <PixelVideo
        className="demo-video"
        src={[eyesWebm, eyesMp4]}
        paused={paused}
        settings={{ ...looks[look], hoverRadius: 200 }}
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
