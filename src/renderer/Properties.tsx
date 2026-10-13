import { useMemo, useState, type ChangeEvent, type ReactElement } from 'react'
import { freeTrackId, hasSource, isVisual, locateClip, nextTrackName } from '../editor/clips.js'
import { moveClips } from '../editor/moveTrim.js'
import { propertyAt, setCanvasSize, setDuration, setFade, setFrameRate, setProperties, setSourceStart, setSpeed, sharedValue, type Fade } from '../editor/properties.js'
import type { MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import { MAX_CANVAS, MIN_CANVAS, type AnimatableProperty, type Clip, type Project } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, PROJECT_FRAME_RATES, TICKS_PER_SECOND, frameDuration, type FrameRate } from '../shared/time.js'
import { useEditorState, usePosition, useSession } from './context.js'
import { IconButton } from './icons.js'
import { NumberField } from './NumberField.js'
import type { Edit } from './store.js'

const FRAME_RATE_DECIMALS = 3
const PERCENT = 100
const MAX_POSITION = 100_000
const MAX_SECONDS = 24 * 60 * 60
const MAX_ROTATION = 36_000
const MAX_SCALE_PERCENT = 10_000

type EditFieldProps = {
  label: string
  testId: string
  command: string
  value: number | undefined
  min: number
  max: number
  step?: number
  decimals?: number
  edit(value: number): Edit
}

// A number field whose scrub, arrow keys and typed values all run as one undoable command.
function EditField({ label, testId, command, value, min, max, step, decimals, edit }: EditFieldProps): ReactElement {
  const { store } = useSession()
  return (
    <NumberField
      label={label}
      testId={testId}
      value={value}
      min={min}
      max={max}
      step={step}
      decimals={decimals}
      onBegin={() => store.begin(command)}
      onChange={(next) => store.update(edit(next))}
      onCommit={store.commit}
      onCancel={store.cancel}
    />
  )
}

function rateKey(rate: FrameRate): string {
  return `${rate.num}/${rate.den}`
}

function rateLabel(rate: FrameRate): string {
  return `${Number((rate.num / rate.den).toFixed(FRAME_RATE_DECIMALS))} fps`
}

function ProjectSettings(): ReactElement {
  const { store } = useSession()
  const canvas = useEditorState((state) => state.project.canvas)

  function onFrameRate(event: ChangeEvent<HTMLSelectElement>): void {
    const chosen = PROJECT_FRAME_RATES.find((rate) => rateKey(rate) === event.target.value)
    if (chosen !== undefined) store.apply('Change Frame Rate', (project) => setFrameRate(project, chosen))
  }

  return (
    <section className="panel-section" aria-label="Project settings">
      <h2 className="panel-title">Project</h2>
      <EditField
        label="Width"
        testId="canvas-width"
        command="Change Canvas Size"
        value={canvas.width}
        min={MIN_CANVAS.width}
        max={MAX_CANVAS.width}
        edit={(width) => (project) => setCanvasSize(project, { width, height: project.canvas.height })}
      />
      <EditField
        label="Height"
        testId="canvas-height"
        command="Change Canvas Size"
        value={canvas.height}
        min={MIN_CANVAS.height}
        max={MAX_CANVAS.height}
        edit={(height) => (project) => setCanvasSize(project, { width: project.canvas.width, height })}
      />
      <label className="number-field">
        <span className="number-field-label plain">Frame rate</span>
        <select className="field" data-testid="frame-rate" value={rateKey(canvas.frameRate)} onChange={onFrameRate}>
          {PROJECT_FRAME_RATES.map((rate) => (
            <option key={rateKey(rate)} value={rateKey(rate)}>
              {rateLabel(rate)}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

function selectedClips(project: Project, selection: readonly string[]): Clip[] {
  const clips: Clip[] = []
  for (const clipId of selection) {
    const located = locateClip(project, clipId)
    if (located !== undefined) clips.push(located.clip)
  }
  return clips
}

// The size a clip's picture has at 100%, after cropping, at the given time.
function shownSize(clip: Clip, mediaStates: MediaStates, time: number): Size | undefined {
  if (clip.type === 'audio') return undefined
  if (clip.type === 'text') {
    const measured = measureText({ text: clip.text, family: clip.font.family, size: clip.font.size })
    return { width: measured.naturalWidth, height: measured.naturalHeight }
  }
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind === 'audio') return undefined
  const natural = state.info.kind === 'video' ? state.info.video : state.info
  const cropX = (propertyAt(clip, 'cropLeft', time) ?? 0) + (propertyAt(clip, 'cropRight', time) ?? 0)
  const cropY = (propertyAt(clip, 'cropTop', time) ?? 0) + (propertyAt(clip, 'cropBottom', time) ?? 0)
  return { width: natural.width - cropX, height: natural.height - cropY }
}

function seconds(ticks: number | undefined): number | undefined {
  return ticks === undefined ? undefined : ticks / TICKS_PER_SECOND
}

function ClipProperties({ clips }: { clips: readonly Clip[] }): ReactElement {
  const mediaStates = useEditorState((state) => state.mediaStates)
  const canvas = useEditorState((state) => state.project.canvas)
  const time = usePosition((position) => position.time)
  const [keepsAspect, setKeepsAspect] = useState(true)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const frameTicks = frameDuration(canvas.frameRate)
  const visual = clips.filter(isVisual)
  const sounding = clips.filter(hasSource)

  function shared(property: AnimatableProperty): number | undefined {
    return sharedValue(clips.map((clip) => propertyAt(clip, property, time)))
  }

  function set(property: AnimatableProperty): (value: number) => Edit {
    return (value) => (project) => setProperties(project, ids, { [property]: value }, time)
  }

  function wholeFrames(valueInSeconds: number): number {
    return Math.round((valueInSeconds * TICKS_PER_SECOND) / frameTicks) * frameTicks
  }

  // Width and height are another way to state the scale, so setting one sets the scale that gives it; with the lock on, the other axis follows.
  function setSide(side: 'width' | 'height'): (value: number) => Edit {
    const axis = side === 'width' ? 'scaleX' : 'scaleY'
    const otherAxis = side === 'width' ? 'scaleY' : 'scaleX'
    return (value) => (project) => {
      let edited = project
      for (const clip of visual) {
        const size = shownSize(clip, mediaStates, time)
        const before = propertyAt(clip, axis, time)
        const other = propertyAt(clip, otherAxis, time)
        if (size === undefined || before === undefined || other === undefined || size[side] <= 0) continue
        const scale = value / size[side]
        const follows = keepsAspect && before > 0 ? { [otherAxis]: (other * scale) / before } : {}
        edited = setProperties(edited, [clip.id], { [axis]: scale, ...follows }, time)
      }
      return edited
    }
  }

  function sizeOf(side: 'width' | 'height'): number | undefined {
    const axis = side === 'width' ? 'scaleX' : 'scaleY'
    return sharedValue(
      visual.map((clip) => {
        const size = shownSize(clip, mediaStates, time)
        const scale = propertyAt(clip, axis, time)
        return size === undefined || scale === undefined ? undefined : size[side] * scale
      }),
    )
  }

  function setStart(valueInSeconds: number): Edit {
    const start = wholeFrames(valueInSeconds)
    return (project) => {
      let edited = project
      for (const clip of clips) {
        const newTrack = { id: freeTrackId(edited, `${clip.id}-track`), name: nextTrackName(edited) }
        edited = moveClips(edited, { clipIds: [clip.id], deltaTime: start - clip.start, targetTrackIndex: undefined, isRipple: false, newTrack })
      }
      return edited
    }
  }

  function fadeField(label: string, fade: Fade, lengths: readonly (number | undefined)[]): ReactElement {
    return (
      <EditField
        label={label}
        testId={`clip-${fade}`}
        command="Change Fade"
        value={seconds(sharedValue(lengths.map((length) => length ?? 0)))}
        min={0}
        max={MAX_SECONDS}
        step={frameTicks / TICKS_PER_SECOND}
        decimals={3}
        edit={(next) => (project) => setFade(project, ids, fade, wholeFrames(next))}
      />
    )
  }

  const scaleX = shared('scaleX')
  const uniformScale = scaleX !== undefined && scaleX === shared('scaleY') ? scaleX * PERCENT : undefined
  const frameSeconds = frameTicks / TICKS_PER_SECOND
  return (
    <>
      {visual.length > 0 && (
        <section className="panel-section" aria-label="Transform">
          <div className="field-row">
            <h2 className="panel-title">Transform</h2>
            <span className="spacer" />
            <IconButton icon="link" label="Keep the aspect ratio" testId="aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />
          </div>
          <EditField label="X" testId="clip-x" command="Move Clip" value={shared('x')} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={set('x')} />
          <EditField label="Y" testId="clip-y" command="Move Clip" value={shared('y')} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={set('y')} />
          <EditField label="Width" testId="clip-width" command="Resize Clip" value={sizeOf('width')} min={0} max={MAX_POSITION} decimals={1} edit={setSide('width')} />
          <EditField label="Height" testId="clip-height" command="Resize Clip" value={sizeOf('height')} min={0} max={MAX_POSITION} decimals={1} edit={setSide('height')} />
          <EditField
            label="Scale %"
            testId="clip-scale"
            command="Resize Clip"
            value={uniformScale}
            min={0}
            max={MAX_SCALE_PERCENT}
            decimals={1}
            edit={(percent) => (project) => setProperties(project, ids, { scaleX: percent / PERCENT, scaleY: percent / PERCENT }, time)}
          />
          <EditField label="Rotation °" testId="clip-rotation" command="Rotate Clip" value={shared('rotation')} min={-MAX_ROTATION} max={MAX_ROTATION} decimals={1} edit={set('rotation')} />
        </section>
      )}
      <section className="panel-section" aria-label="Timing">
        <h2 className="panel-title">Timing</h2>
        <EditField label="Start s" testId="clip-start" command="Move Clip" value={seconds(sharedValue(clips.map((clip) => clip.start)))} min={0} max={MAX_SECONDS} step={frameSeconds} decimals={3} edit={setStart} />
        <EditField
          label="Duration s"
          testId="clip-duration"
          command="Trim Clip"
          value={seconds(sharedValue(clips.map((clip) => clip.duration)))}
          min={frameSeconds}
          max={MAX_SECONDS}
          step={frameSeconds}
          decimals={3}
          edit={(next) => (project) => setDuration(project, ids, wholeFrames(next), frameTicks, mediaStates)}
        />
        {sounding.length > 0 && (
          <>
            <EditField
              label="Source offset s"
              testId="clip-source-start"
              command="Change Source Offset"
              value={seconds(sharedValue(sounding.map((clip) => clip.sourceStart)))}
              min={0}
              max={MAX_SECONDS}
              step={frameSeconds}
              decimals={3}
              edit={(next) => (project) => setSourceStart(project, ids, next * TICKS_PER_SECOND, mediaStates)}
            />
            <EditField
              label="Speed %"
              testId="clip-speed"
              command="Change Speed"
              value={sharedValue(sounding.map((clip) => clip.speedPercent))}
              min={MIN_SPEED_PERCENT}
              max={MAX_SPEED_PERCENT}
              edit={(percent) => (project) => setSpeed(project, ids, percent)}
            />
          </>
        )}
      </section>
      {visual.length > 0 && (
        <section className="panel-section" aria-label="Opacity and fades">
          <h2 className="panel-title">Opacity</h2>
          <EditField
            label="Opacity %"
            testId="clip-opacity"
            command="Change Opacity"
            value={sharedValue(visual.map((clip) => (propertyAt(clip, 'opacity', time) ?? 1) * PERCENT))}
            min={0}
            max={PERCENT}
            edit={(percent) => set('opacity')(percent / PERCENT)}
          />
          {fadeField('Fade in s', 'fadeIn', visual.map((clip) => clip.fadeIn))}
          {fadeField('Fade out s', 'fadeOut', visual.map((clip) => clip.fadeOut))}
        </section>
      )}
      {sounding.length > 0 && (
        <section className="panel-section" aria-label="Volume and fades">
          <h2 className="panel-title">Volume</h2>
          <EditField
            label="Volume %"
            testId="clip-volume"
            command="Change Volume"
            value={sharedValue(sounding.map((clip) => (propertyAt(clip, 'volume', time) ?? 1) * PERCENT))}
            min={0}
            max={2 * PERCENT}
            edit={(percent) => set('volume')(percent / PERCENT)}
          />
          {fadeField('Fade in s', 'volumeFadeIn', sounding.map((clip) => clip.volumeFadeIn))}
          {fadeField('Fade out s', 'volumeFadeOut', sounding.map((clip) => clip.volumeFadeOut))}
        </section>
      )}
    </>
  )
}

export function Properties(): ReactElement {
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const clips = useMemo(() => selectedClips(project, selection), [project, selection])
  return clips.length === 0 ? <ProjectSettings /> : <ClipProperties clips={clips} />
}
