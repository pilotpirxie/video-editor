import type { ReactElement } from 'react'
import type { Size } from '../shared/exportPresets.js'
import type { EngineHost } from './engineHost.js'

// Fitted to the panel, or a percentage of the canvas's own pixels: at 100 % one canvas pixel is one pixel of the screen.
export type PreviewZoom = 'fit' | number

const PERCENT = 100

function previewSize(canvas: Size, stage: DOMRect, zoom: PreviewZoom): Size {
  if (zoom !== 'fit') return { width: (canvas.width * zoom) / PERCENT / devicePixelRatio, height: (canvas.height * zoom) / PERCENT / devicePixelRatio }
  const scale = Math.min(stage.width / canvas.width, stage.height / canvas.height)
  return { width: canvas.width * scale, height: canvas.height * scale }
}

// Keeps the preview element at the project's aspect ratio and tells the engine how many device pixels to draw.
// Above 100 % the canvas's own pixels are shown larger, each a square of screen pixels: drawing more of them would show nothing more and cost memory.
export function keepPreviewSized(preview: HTMLCanvasElement, stage: HTMLElement, canvas: Size, zoom: PreviewZoom, engine: EngineHost): () => void {
  const isMagnified = zoom !== 'fit' && zoom > PERCENT
  function layOut(): void {
    const size = previewSize(canvas, stage.getBoundingClientRect(), zoom)
    preview.style.width = `${size.width}px`
    preview.style.height = `${size.height}px`
    preview.style.imageRendering = isMagnified ? 'pixelated' : ''
    const drawn = isMagnified ? canvas : { width: size.width * devicePixelRatio, height: size.height * devicePixelRatio }
    engine.send({ type: 'resize', width: drawn.width, height: drawn.height })
  }
  layOut()
  const observer = new ResizeObserver(layOut)
  observer.observe(stage)
  return () => observer.disconnect()
}

export function PreviewZoomButtons({ zoom, onZoom }: { zoom: PreviewZoom; onZoom(zoom: PreviewZoom): void }): ReactElement {
  return (
    <div className="segmented" role="group" aria-label="Preview zoom">
      <button type="button" className="button" data-testid="zoom-fit" aria-pressed={zoom === 'fit'} onClick={() => onZoom('fit')}>
        Fit
      </button>
      <button type="button" className="button" data-testid="zoom-actual" aria-pressed={zoom === PERCENT} onClick={() => onZoom(PERCENT)}>
        100%
      </button>
    </div>
  )
}
