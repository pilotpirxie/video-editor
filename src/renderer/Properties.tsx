import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { freeTrackId, hasSource, isVisual, locateClip, makesSound, nextTrackName } from '../editor/clips.js'
import { moveClips } from '../editor/moveTrim.js'
import { propertyAt, setCanvasSize, setDuration, setFade, setFrameRate, setLoop, setProperties, setSourceStart, setSpeed, sharedValue, type Fade } from '../editor/properties.js'
import { setTextStyle } from '../editor/text.js'
import type { MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import { describeError, logError } from '../shared/log.js'
import { MAX_CANVAS, MIN_CANVAS, type AnimatableProperty, type Clip, type Project, type TextAlign, type VideoClip } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, PROJECT_FRAME_RATES, TICKS_PER_SECOND, frameDuration, type FrameRate } from '../shared/time.js'
import { useEditorState, usePosition, useSession } from './context.js'
import { installedFontFamilies } from './fonts.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { NumberField } from './NumberField.js'
import { Picker } from './Picker.js'
import { updateStep, type Edit } from './store.js'
import { endTextEdit, typeText, type TextClip } from './TextEditor.js'

const FRAME_RATE_DECIMALS = 3
const PERCENT = 100
const MAX_POSITION = 100_000
const MAX_SECONDS = 24 * 60 * 60
const MAX_ROTATION = 36_000
const MAX_SCALE_PERCENT = 10_000
const MAX_FONT_SIZE = 2000
const OPAQUE_COLOR_LENGTH = 7
const TEXT_SIZES = [24, 36, 48, 64, 72, 96, 120, 144, 200, 288]
const SCALES = [25, 50, 75, 100, 150, 200]
const ROTATIONS = [-90, -45, 0, 45, 90, 180]
const OPACITIES = [0, 25, 50, 75, 100]
const VOLUMES = [0, 25, 50, 75, 100, 150, 200]
const SPEEDS = [25, 50, 100, 200, 400, 800, 1600, 5000, 10_000]
const FADE_SECONDS = [0, 0.25, 0.5, 1, 2, 3]
const ALIGNMENTS: readonly { align: TextAlign; icon: IconName; label: string }[] = [
  { align: 'left', icon: 'alignLeft', label: 'Align left' },
  { align: 'center', icon: 'alignCenter', label: 'Align centre' },
  { align: 'right', icon: 'alignRight', label: 'Align right' },
]

type EditFieldProps = {
  label: string
  testId: string
  command: string
  value: number | undefined
  min: number
  max: number
  step?: number
  decimals?: number
  presets?: readonly number[]
  edit(value: number): Edit
}

// A number field whose scrub, arrow keys, typed values and ready-made values all run as one undoable command.
function EditField({ label, testId, command, value, min, max, step, decimals, presets, edit }: EditFieldProps): ReactElement {
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
      presets={presets}
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

type GroupProps = {
  title: string
  // Controls that belong to the whole group, shown at the end of its title line.
  actions?: ReactElement
  children: ReactNode
}

// Fields that belong together, under a title that folds them away. What is folded stays folded the next time the editor opens.
function Group({ title, actions, children }: GroupProps): ReactElement {
  const storageKey = `group-${title}`
  const [isOpen, setIsOpen] = useState(() => localStorage.getItem(storageKey) !== 'closed')

  function toggle(): void {
    setIsOpen(!isOpen)
    try {
      localStorage.setItem(storageKey, isOpen ? 'closed' : 'open')
    } catch (error) {
      logError('Could not remember which groups are folded', error)
    }
  }

  return (
    <section className="group" aria-label={title}>
      <div className="group-header">
        <button type="button" className="group-toggle focusable" aria-expanded={isOpen} data-testid={`group-${title.toLowerCase()}`} onClick={toggle}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />
          {title}
        </button>
        {actions}
      </div>
      {isOpen && <div className="group-body">{children}</div>}
    </section>
  )
}

function ProjectSettings(): ReactElement {
  const { store } = useSession()
  const canvas = useEditorState((state) => state.project.canvas)

  function onFrameRate(key: string): void {
    const chosen = PROJECT_FRAME_RATES.find((rate) => rateKey(rate) === key)
    if (chosen !== undefined) store.apply('Change Frame Rate', (project) => setFrameRate(project, chosen))
  }

  return (
    <Group title="Project">
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
      <div className="labelled">
        <span className="field-label">Frame rate</span>
        <Picker
          label="Frame rate"
          testId="frame-rate"
          choices={PROJECT_FRAME_RATES.map((rate) => ({ value: rateKey(rate), label: rateLabel(rate) }))}
          value={rateKey(canvas.frameRate)}
          onChoose={onFrameRate}
        />
      </div>
    </Group>
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

function isText(clip: Clip): clip is TextClip {
  return clip.type === 'text'
}

function isAnimatedImage(clip: Clip, mediaStates: MediaStates): clip is VideoClip {
  if (clip.type !== 'video') return false
  const state = mediaStates[clip.mediaId]
  return state !== undefined && 'info' in state && state.info.kind === 'video' && state.info.isAnimatedImage === true
}

// Words and look of the selected text clips. Each control changes all of them.
function TextFields({ clips }: { clips: readonly TextClip[] }): ReactElement {
  const { store } = useSession()
  const [installed, setInstalled] = useState<readonly string[]>([])
  const isTypingRef = useRef(false)
  const isPickingRef = useRef(false)
  const isTryingFontRef = useRef(false)
  const colorRef = useRef<HTMLInputElement>(null)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const [firstId] = ids
  const text = sharedValue(clips.map((clip) => clip.text))
  const family = sharedValue(clips.map((clip) => clip.font.family))
  const color = sharedValue(clips.map((clip) => clip.color))
  const align = sharedValue(clips.map((clip) => clip.align))

  // The list is read when the panel appears. Should the system want a click first, opening the font control asks again, and only then is a failure worth a notice.
  const isShownRef = useRef(true)
  async function listFonts(isAskedByUser: boolean): Promise<void> {
    try {
      const families = await installedFontFamilies()
      if (isShownRef.current) setInstalled(families)
    } catch (error) {
      logError('Could not list the installed fonts', error)
      if (isAskedByUser) store.notify(`The installed fonts could not be listed: ${describeError(error)}`)
    }
  }

  useEffect(() => {
    isShownRef.current = true
    void listFonts(false)
    return () => {
      isShownRef.current = false
    }
    // Once per appearance of the panel: the list does not depend on which clips are selected.
  }, [])

  // The colour picker reports every colour it passes over; they become one undo step, closed when the picker is.
  useEffect(() => {
    const field = colorRef.current
    if (field === null) return
    const endPicking = (): void => {
      if (!isPickingRef.current) return
      isPickingRef.current = false
      store.commit()
    }
    field.addEventListener('change', endPicking)
    field.addEventListener('blur', endPicking)
    return () => {
      field.removeEventListener('change', endPicking)
      field.removeEventListener('blur', endPicking)
      endPicking()
    }
  }, [store])

  function endTyping(): void {
    if (!isTypingRef.current || firstId === undefined) return
    isTypingRef.current = false
    endTextEdit(store, firstId)
  }

  function onText(typed: string): void {
    typeText(store, ids, typed, isTypingRef.current)
    isTypingRef.current = true
  }

  // The picker has no transparency, so each clip keeps the transparency its colour had.
  function onColor(picked: string): void {
    const edit: Edit = (project) => {
      let edited = project
      for (const clip of clips) edited = setTextStyle(edited, [clip.id], { color: `${picked}${clip.color.slice(OPAQUE_COLOR_LENGTH)}` })
      return edited
    }
    updateStep(store, 'Change Text Colour', edit, isPickingRef.current)
    isPickingRef.current = true
  }

  // The font under the pointer, or reached with the arrow keys, is shown on the canvas at once; only choosing it makes it an undo step.
  function tryFont(name: string): void {
    updateStep(store, 'Change Font', (project) => setTextStyle(project, ids, { family: name }), isTryingFontRef.current)
    isTryingFontRef.current = true
  }

  function chooseFont(name: string): void {
    tryFont(name)
    isTryingFontRef.current = false
    store.commit()
  }

  function putFontBack(): void {
    if (isTryingFontRef.current) store.cancel()
    isTryingFontRef.current = false
  }

  // Before the list has arrived, and for a font this Mac does not have, the fonts in use are still offered.
  const families = [...new Set([...clips.map((clip) => clip.font.family), ...installed])].sort((a, b) => a.localeCompare(b))
  return (
    <>
      <label className="labelled">
        <span className="field-label">Words</span>
        <textarea
          className="field text-field"
          data-testid="text-words"
          rows={2}
          placeholder={text === undefined ? 'Mixed' : undefined}
          value={text ?? ''}
          onChange={(event) => onText(event.target.value)}
          onBlur={endTyping}
        />
      </label>
      <div
        className="labelled"
        onFocus={() => {
          if (installed.length === 0) void listFonts(true)
        }}
      >
        <span className="field-label">Font</span>
        <Picker
          label="Font"
          testId="text-font"
          choices={families.map((name) => ({ value: name, label: name }))}
          value={family}
          onPreview={tryFont}
          onChoose={chooseFont}
          onClose={putFontBack}
        />
      </div>
      <EditField
        label="Size"
        testId="text-size"
        command="Change Text Size"
        value={sharedValue(clips.map((clip) => clip.font.size))}
        min={1}
        max={MAX_FONT_SIZE}
        presets={TEXT_SIZES}
        edit={(size) => (project) => setTextStyle(project, ids, { size })}
      />
      <label className="labelled">
        <span className="field-label">Colour</span>
        <input
          ref={colorRef}
          className="color-field"
          type="color"
          data-testid="text-color"
          value={(color ?? clips[0]?.color ?? '').slice(0, OPAQUE_COLOR_LENGTH)}
          onChange={(event) => onColor(event.target.value)}
        />
      </label>
      <div className="labelled">
        <span className="field-label">Alignment</span>
        <div className="segmented wide" role="group" aria-label="Alignment">
          {ALIGNMENTS.map((option) => (
            <IconButton
              key={option.align}
              icon={option.icon}
              label={option.label}
              testId={`text-align-${option.align}`}
              isPressed={align === option.align}
              onClick={() => store.apply('Change Alignment', (project) => setTextStyle(project, ids, { align: option.align }))}
            />
          ))}
        </div>
      </div>
    </>
  )
}

function ClipProperties({ clips }: { clips: readonly Clip[] }): ReactElement {
  const mediaStates = useEditorState((state) => state.mediaStates)
  const canvas = useEditorState((state) => state.project.canvas)
  const time = usePosition((position) => position.time)
  const [keepsAspect, setKeepsAspect] = useState(true)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const frameTicks = frameDuration(canvas.frameRate)
  const { store } = useSession()
  const visual = clips.filter(isVisual)
  const texts = clips.filter(isText)
  const sourced = clips.filter(hasSource)
  const loopable = clips.filter((clip) => isAnimatedImage(clip, mediaStates))
  const isLooping = loopable.length > 0 && loopable.every((clip) => clip.loop === true)
  const sounding = sourced.filter((clip) => makesSound(clip, mediaStates))

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
        presets={FADE_SECONDS}
        edit={(next) => (project) => setFade(project, ids, fade, wholeFrames(next))}
      />
    )
  }

  const scaleX = shared('scaleX')
  const uniformScale = scaleX !== undefined && scaleX === shared('scaleY') ? scaleX * PERCENT : undefined
  const frameSeconds = frameTicks / TICKS_PER_SECOND
  return (
    <>
      {texts.length > 0 && (
        <Group title="Text">
          <TextFields clips={texts} />
        </Group>
      )}
      {visual.length > 0 && (
        <Group title="Transform" actions={<IconButton icon="link" label="Keep the aspect ratio" testId="aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />}>
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
            presets={SCALES}
            edit={(percent) => (project) => setProperties(project, ids, { scaleX: percent / PERCENT, scaleY: percent / PERCENT }, time)}
          />
          <EditField
            label="Rotation °"
            testId="clip-rotation"
            command="Rotate Clip"
            value={shared('rotation')}
            min={-MAX_ROTATION}
            max={MAX_ROTATION}
            decimals={1}
            presets={ROTATIONS}
            edit={set('rotation')}
          />
        </Group>
      )}
      <Group title="Timing">
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
        {sourced.length > 0 && (
          <>
            <EditField
              label="Source offset s"
              testId="clip-source-start"
              command="Change Source Offset"
              value={seconds(sharedValue(sourced.map((clip) => clip.sourceStart)))}
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
              value={sharedValue(sourced.map((clip) => clip.speedPercent))}
              min={MIN_SPEED_PERCENT}
              max={MAX_SPEED_PERCENT}
              presets={SPEEDS}
              edit={(percent) => (project) => setSpeed(project, ids, percent)}
            />
          </>
        )}
        {loopable.length > 0 && (
          <label className="check-field">
            <input
              type="checkbox"
              data-testid="clip-loop"
              checked={isLooping}
              onChange={(event) => store.apply(event.target.checked ? 'Loop Clip' : 'Stop Looping', (project) => setLoop(project, ids, event.target.checked, mediaStates))}
            />
            Loop
          </label>
        )}
      </Group>
      {visual.length > 0 && (
        <Group title="Opacity">
          <EditField
            label="Opacity %"
            testId="clip-opacity"
            command="Change Opacity"
            value={sharedValue(visual.map((clip) => (propertyAt(clip, 'opacity', time) ?? 1) * PERCENT))}
            min={0}
            max={PERCENT}
            presets={OPACITIES}
            edit={(percent) => set('opacity')(percent / PERCENT)}
          />
          {fadeField('Fade in s', 'fadeIn', visual.map((clip) => clip.fadeIn))}
          {fadeField('Fade out s', 'fadeOut', visual.map((clip) => clip.fadeOut))}
        </Group>
      )}
      {sounding.length > 0 && (
        <Group title="Volume">
          <EditField
            label="Volume %"
            testId="clip-volume"
            command="Change Volume"
            value={sharedValue(sounding.map((clip) => (propertyAt(clip, 'volume', time) ?? 1) * PERCENT))}
            min={0}
            max={2 * PERCENT}
            presets={VOLUMES}
            edit={(percent) => set('volume')(percent / PERCENT)}
          />
          {fadeField('Fade in s', 'volumeFadeIn', sounding.map((clip) => clip.volumeFadeIn))}
          {fadeField('Fade out s', 'volumeFadeOut', sounding.map((clip) => clip.volumeFadeOut))}
        </Group>
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
