import type { ReactElement } from 'react'
import type { Size } from '../shared/exportPresets.js'
import type { EngineHost } from './engineHost.js'

export type PreviewZoom = 'fit' | 'actual'

function previewSize(canvas: Size, stage: DOMRect, zoom: PreviewZoom): Size {
  if (zoom === 'actual') return { width: canvas.width / devicePixelRatio, height: canvas.height / devicePixelRatio }
  const scale = Math.min(stage.width / canvas.width, stage.height / canvas.height)
  return { width: canvas.width * scale, height: canvas.height * scale }
}

// Keeps the preview element at the project's aspect ratio and tells the engine how many device pixels to draw.
export function keepPreviewSized(preview: HTMLCanvasElement, stage: HTMLElement, canvas: Size, zoom: PreviewZoom, engine: EngineHost): () => void {
  function layOut(): void {
    const size = previewSize(canvas, stage.getBoundingClientRect(), zoom)
    preview.style.width = `${size.width}px`
    preview.style.height = `${size.height}px`
    engine.send({ type: 'resize', width: size.width * devicePixelRatio, height: size.height * devicePixelRatio })
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
      <button type="button" className="button" data-testid="zoom-actual" aria-pressed={zoom === 'actual'} onClick={() => onZoom('actual')}>
        100%
      </button>
    </div>
  )
}
