import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ANIMATION_NAMES, DEFAULT_ANIMATION, setAnimation, takesAnimation } from '../editor/animations.js'
import { CALLOUT_NAMES, setArrowStyle, setCalloutStyle } from '../editor/annotations.js'
import { deleteZoom, setZoom, type ZoomChanges } from '../editor/camera.js'
import { allClips, freeTrackId, hasMedia, hasSource, isCroppable, isVisual, makesSound, nextTrackName } from '../editor/clips.js'
import { cropFromValue } from '../editor/geometry.js'
import { moveClips } from '../editor/moveTrim.js'
import {
  hasKeyframesAt,
  nearestKeyframe,
  propertyAt,
  setCanvasSize,
  setDuration,
  setFade,
  setFrameRate,
  setKeyframesAt,
  setLoop,
  setProperties,
  setSoundSwitches,
  setSourceStart,
  setSpeed,
  sharedValue,
  type Fade,
  type KeyframeSet,
} from '../editor/properties.js'
import { setShapeStyle, type ShapeStyle } from '../editor/shapes.js'
import { missingFonts, setTextStyle, type TextStyle } from '../editor/text.js'
import { DEFAULT_TRANSITION, TRANSITION_NAMES, setTransition, type TransitionEdge } from '../editor/transitions.js'
import type { MediaStates } from '../engine/resolve.js'
import { arrowSize } from '../engine/annotations.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import { describeErrorAsSentence, logError } from '../shared/log.js'
import {
  ANIMATION_TYPES,
  ARROW_HEADS,
  CALLOUT_SHAPES,
  MAX_CAMERA_SCALE,
  MAX_CANVAS,
  MIN_CANVAS,
  TRANSITION_TYPES,
  type AnimatableProperty,
  type AnimationType,
  type ArrowClip,
  type ArrowHead,
  type BlurClip,
  type CalloutClip,
  type Clip,
  type Crop,
  type Easing,
  type HighlightClip,
  type Project,
  type Shape,
  type ShapeClip,
  type TextAlign,
  type TextClip,
  type Transform,
  type VideoClip,
  type VisualClip,
} from '../shared/project.js'
import { FAST_SOUND_ABOVE_PERCENT, MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, PROJECT_FRAME_RATES, TICKS_PER_SECOND, frameDuration, type FrameRate } from '../shared/time.js'
import { useEditorState, usePosition, useSession } from './context.js'
import { installedFontFamilies } from './fonts.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { NumberField } from './NumberField.js'
import { Picker } from './Picker.js'
import { updateStep, type Edit } from './store.js'
import { endTextEdit, typeText } from './TextEditor.js'

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
const MOVE_SECONDS = [0.25, 0.5, 1, 2, 3]
const ZOOM_SCALES = [100, 150, 200, 300, 400]
const NONE = 'none'
const REGULAR_WEIGHT = 400
const LINE_SPACINGS = [0.8, 1, 1.2, 1.5, 2]
const LINE_SPACING = { min: 0.5, max: 3, step: 0.05 }
const WEIGHTS: readonly { weight: number; label: string }[] = [
  { weight: 100, label: 'Thin' },
  { weight: 200, label: 'Extra light' },
  { weight: 300, label: 'Light' },
  { weight: 400, label: 'Regular' },
  { weight: 500, label: 'Medium' },
  { weight: 600, label: 'Semibold' },
  { weight: 700, label: 'Bold' },
  { weight: 800, label: 'Extra bold' },
  { weight: 900, label: 'Black' },
]
const HEAD_NAMES: Record<ArrowHead, string> = { none: 'None', triangle: 'Triangle', open: 'Open', dot: 'Dot' }
const ARROW_ENDS = [
  { key: 'startHead', label: 'Start' },
  { key: 'endHead', label: 'End' },
] as const
const EASINGS: readonly { easing: Easing; label: string }[] = [
  { easing: 'easeInOut', label: 'Ease in and out' },
  { easing: 'easeIn', label: 'Ease in' },
  { easing: 'easeOut', label: 'Ease out' },
  { easing: 'linear', label: 'Linear' },
  { easing: 'hold', label: 'Hold' },
]
const SHAPES: readonly { shape: Shape; label: string }[] = [
  { shape: 'rectangle', label: 'Rectangle' },
  { shape: 'ellipse', label: 'Ellipse' },
]
const CROP_SIDES: readonly { side: keyof Crop; property: AnimatableProperty; label: string }[] = [
  { side: 'left', property: 'cropLeft', label: 'Left' },
  { side: 'top', property: 'cropTop', label: 'Top' },
  { side: 'right', property: 'cropRight', label: 'Right' },
  { side: 'bottom', property: 'cropBottom', label: 'Bottom' },
]
const ALIGNMENTS: readonly { align: TextAlign; icon: IconName; label: string }[] = [
  { align: 'left', icon: 'alignLeft', label: 'Align left' },
  { align: 'center', icon: 'alignCenter', label: 'Align centre' },
  { align: 'right', icon: 'alignRight', label: 'Align right' },
]
const KEYFRAME_NAMES: Record<KeyframeSet, string> = { position: 'Position', size: 'Size', rotation: 'Rotation', opacity: 'Opacity', crop: 'Crop', volume: 'Volume' }

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
  keyframes?: ReactElement
  edit(value: number): Edit
}

// A number field whose scrub, arrow keys, typed values and ready-made values all run as one undoable command.
export function EditField({ label, testId, command, value, min, max, step, decimals, presets, keyframes, edit }: EditFieldProps): ReactElement {
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
      keyframes={keyframes}
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
  icon: IconName
  // Controls that belong to the whole group, shown at the end of its title line.
  actions?: ReactElement
  // Groups start folded each time the editor opens, except these.
  isOpenAtStart?: boolean
  children: ReactNode
}

type ColorFieldProps = {
  label: string
  testId: string
  command: string
  // Undefined means the selected clips do not agree on a colour.
  value: string | undefined
  edit(color: string): Edit
}

// The colour picker reports every colour it passes over; they become one undo step, closed when the picker is.
export function ColorField({ label, testId, command, value, edit }: ColorFieldProps): ReactElement {
  const { store } = useSession()
  const fieldRef = useRef<HTMLInputElement>(null)
  const isPickingRef = useRef(false)

  useEffect(() => {
    const field = fieldRef.current
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

  function onColor(picked: string): void {
    updateStep(store, command, edit(picked), isPickingRef.current)
    isPickingRef.current = true
  }

  return (
    <label className="labelled">
      <span className="field-label">{label}</span>
      <input ref={fieldRef} className="color-field" type="color" data-testid={testId} value={(value ?? '').slice(0, OPAQUE_COLOR_LENGTH)} onChange={(event) => onColor(event.target.value)} />
    </label>
  )
}

// Fields that belong together, under a title that folds them away. What is folded or unfolded stays so while the window is open.
export function Group({ title, icon, actions, isOpenAtStart = false, children }: GroupProps): ReactElement {
  const storageKey = `group-${title}`
  const [isOpen, setIsOpen] = useState(() => {
    const stored = sessionStorage.getItem(storageKey)
    return stored === null ? isOpenAtStart : stored === 'open'
  })

  function toggle(): void {
    setIsOpen(!isOpen)
    try {
      sessionStorage.setItem(storageKey, isOpen ? 'closed' : 'open')
    } catch (error) {
      logError('Could not remember which groups are folded', error)
    }
  }

  return (
    <section className="group" aria-label={title}>
      <div className="group-header">
        <button type="button" className="group-toggle focusable" aria-expanded={isOpen} data-testid={`group-${title.toLowerCase().replaceAll(' ', '-')}`} onClick={toggle}>
          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />
          <Icon name={icon} />
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
  // The picture is fitted into every new size, so a new shape typed one side at a time would shrink it twice; linked, both sides change in one step.
  const [keepsAspect, setKeepsAspect] = useState(true)

  function onFrameRate(key: string): void {
    const chosen = PROJECT_FRAME_RATES.find((rate) => rateKey(rate) === key)
    if (chosen !== undefined) store.apply('Change Frame Rate', (project) => setFrameRate(project, chosen))
  }

  function setSide(side: 'width' | 'height'): (value: number) => Edit {
    return (value) => (project) => {
      const { width, height } = project.canvas
      if (side === 'width') return setCanvasSize(project, { width: value, height: keepsAspect ? (value * height) / width : height })
      return setCanvasSize(project, { width: keepsAspect ? (value * width) / height : width, height: value })
    }
  }

  return (
    <Group title="Project" icon="film" isOpenAtStart actions={<IconButton icon="link" label="Keep the aspect ratio" testId="canvas-aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />}>
      <EditField label="Width" testId="canvas-width" command="Change Canvas Size" value={canvas.width} min={MIN_CANVAS.width} max={MAX_CANVAS.width} edit={setSide('width')} />
      <EditField label="Height" testId="canvas-height" command="Change Canvas Size" value={canvas.height} min={MIN_CANVAS.height} max={MAX_CANVAS.height} edit={setSide('height')} />
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

// The selected clips, in the order they were selected. One pass over the project, however many are selected.
export function selectedClips(project: Project, selection: readonly string[]): Clip[] {
  const wanted = new Set(selection)
  const found = new Map<string, Clip>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (wanted.has(clip.id)) found.set(clip.id, clip)
    }
  }
  const clips: Clip[] = []
  for (const clipId of selection) {
    const clip = found.get(clipId)
    if (clip !== undefined) clips.push(clip)
  }
  return clips
}

// The whole picture of a clip as its media has it; nothing for sound, for clips without media, and for media that is missing.
function pictureSize(clip: Clip, mediaStates: MediaStates): Size | undefined {
  if (!hasMedia(clip) || clip.type === 'audio') return undefined
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind === 'audio') return undefined
  return state.info.kind === 'video' ? state.info.video : state.info
}

// The size a clip's picture has at 100%, after cropping, at the given time.
function shownSize(clip: Clip, mediaStates: MediaStates, time: number): Size | undefined {
  if (clip.type === 'text') {
    const measured = measureText(clip)
    return { width: measured.naturalWidth, height: measured.naturalHeight }
  }
  if (clip.type === 'blur' || clip.type === 'highlight' || clip.type === 'callout') return { width: clip.width, height: clip.height }
  if (clip.type === 'arrow') return arrowSize(clip)
  // A group has no size of its own: it is as large as its members make it.
  if (clip.type === 'group') return undefined
  const natural = pictureSize(clip, mediaStates)
  if (natural === undefined) return undefined
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

function hasWords(clip: Clip): clip is WordsClip {
  return clip.type === 'text' || clip.type === 'callout'
}

function isCallout(clip: Clip): clip is CalloutClip {
  return clip.type === 'callout'
}

function isArrow(clip: Clip): clip is ArrowClip {
  return clip.type === 'arrow'
}

// The picker has no transparency, so a colour keeps the transparency it had.
function withAlphaOf(current: string | undefined, picked: string): string {
  return `${picked}${(current ?? '').slice(OPAQUE_COLOR_LENGTH)}`
}

// Crop and placement of a clip at a moment, with whatever animates them.
function placementAt(clip: Clip, time: number): { crop: Crop; transform: Transform } {
  const at = (property: AnimatableProperty): number => propertyAt(clip, property, time) ?? 0
  return {
    crop: { left: at('cropLeft'), top: at('cropTop'), right: at('cropRight'), bottom: at('cropBottom') },
    transform: { x: at('x'), y: at('y'), scaleX: at('scaleX'), scaleY: at('scaleY'), rotation: at('rotation') },
  }
}

function isBlur(clip: Clip): clip is BlurClip {
  return clip.type === 'blur'
}

function isHighlight(clip: Clip): clip is HighlightClip {
  return clip.type === 'highlight'
}

function isAnimatedImage(clip: Clip, mediaStates: MediaStates): clip is VideoClip {
  if (clip.type !== 'video') return false
  const state = mediaStates[clip.mediaId]
  return state !== undefined && 'info' in state && state.info.kind === 'video' && state.info.isAnimatedImage === true
}

type WordsClip = TextClip | CalloutClip

// Words and look of the selected text clips and callouts. Each control changes all of them.
function TextFields({ clips }: { clips: readonly WordsClip[] }): ReactElement {
  const { store } = useSession()
  const [installed, setInstalled] = useState<readonly string[]>([])
  const isTypingRef = useRef(false)
  const isTryingFontRef = useRef(false)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const [firstId] = ids
  const text = sharedValue(clips.map((clip) => clip.text))
  const family = sharedValue(clips.map((clip) => clip.font.family))
  const color = sharedValue(clips.map((clip) => clip.color))
  const align = sharedValue(clips.map((clip) => clip.align))
  // A fixed width and a background are for text clips; a callout has a box and a fill of its own.
  const boxed = clips.filter(isText)
  const isWrapped = boxed.length > 0 && boxed.every((clip) => clip.boxWidth !== undefined)
  const hasOutline = clips.every((clip) => clip.outline !== undefined)
  const hasShadow = clips.every((clip) => clip.shadow !== undefined)
  const hasBackground = boxed.length > 0 && boxed.every((clip) => clip.background !== undefined)

  function style(label: string, wanted: TextStyle): void {
    store.apply(label, (project) => setTextStyle(project, ids, wanted))
  }

  function set(styleOf: (value: number) => TextStyle): (value: number) => Edit {
    return (value) => (project) => setTextStyle(project, ids, styleOf(value))
  }

  // Wrapping starts at the width the text has now, so switching it on changes nothing until the box is made narrower.
  function wrap(isOn: boolean): void {
    store.apply(isOn ? 'Wrap Text' : 'Stop Wrapping Text', (project) => {
      let edited = project
      for (const clip of boxed) edited = setTextStyle(edited, [clip.id], { boxWidth: isOn ? Math.ceil(measureText(clip).naturalWidth) : 'auto' })
      return edited
    })
  }

  // The list is read when the panel appears. Should the system want a click first, opening the font control asks again, and only then is a failure worth a notice.
  const isShownRef = useRef(true)
  async function listFonts(isAskedByUser: boolean): Promise<void> {
    try {
      const families = await installedFontFamilies()
      if (isShownRef.current) setInstalled(families)
    } catch (error) {
      logError('Could not list the installed fonts', error)
      if (isAskedByUser) store.notify(`The installed fonts could not be listed: ${describeErrorAsSentence(error)} Only the fonts the project already uses can be chosen.`)
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

  function endTyping(): void {
    if (!isTypingRef.current || firstId === undefined) return
    isTypingRef.current = false
    endTextEdit(store, firstId)
  }

  function onText(typed: string): void {
    typeText(store, ids, typed, isTypingRef.current)
    isTypingRef.current = true
  }

  // One colour of every clip, each keeping the transparency it had.
  function withColor(colorOf: (clip: WordsClip) => string | undefined, styleOf: (color: string) => TextStyle): (picked: string) => Edit {
    return (picked) => (project) => {
      let edited = project
      for (const clip of clips) edited = setTextStyle(edited, [clip.id], styleOf(withAlphaOf(colorOf(clip), picked)))
      return edited
    }
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
  // Until the list has arrived nothing is known to be missing.
  const missing = installed.length === 0 ? [] : missingFonts(clips, installed)
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
          choices={families.map((name) => ({ value: name, label: missing.includes(name) ? `${name} (not installed)` : name }))}
          value={family}
          onPreview={tryFont}
          onChoose={chooseFont}
          onClose={putFontBack}
        />
        {missing.length > 0 && (
          <p className="hint missing-font" data-testid="text-font-missing">
            <span className="badge warning">Missing</span> {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not installed on this Mac and shown in the system font. The name is kept for Macs that have it.
          </p>
        )}
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
      <ColorField
        label="Colour"
        testId="text-color"
        command="Change Text Colour"
        value={color ?? clips[0]?.color}
        edit={withColor(
          (clip) => clip.color,
          (picked) => ({ color: picked }),
        )}
      />
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
              onClick={() => style('Change Alignment', { align: option.align })}
            />
          ))}
        </div>
      </div>
      <div className="labelled">
        <span className="field-label">Weight</span>
        <Picker
          label="Weight"
          testId="text-weight"
          choices={WEIGHTS.map(({ weight, label }) => ({ value: String(weight), label }))}
          value={sharedValue(clips.map((clip) => String(clip.font.weight ?? REGULAR_WEIGHT)))}
          onChoose={(chosen) => style('Change Weight', { weight: Number(chosen) })}
        />
      </div>
      <EditField
        label="Line spacing"
        testId="text-line-spacing"
        command="Change Line Spacing"
        value={sharedValue(clips.map((clip) => clip.lineSpacing ?? 1))}
        min={LINE_SPACING.min}
        max={LINE_SPACING.max}
        step={LINE_SPACING.step}
        decimals={2}
        presets={LINE_SPACINGS}
        edit={set((lineSpacing) => ({ lineSpacing }))}
      />
      {boxed.length > 0 && <SwitchField label="Fixed-width box" testId="text-wrap" isOn={isWrapped} onSwitch={wrap} />}
      {isWrapped && (
        <EditField
          label="Box width"
          testId="text-box-width"
          command="Change Box Width"
          value={sharedValue(boxed.map((clip) => clip.boxWidth))}
          min={1}
          max={MAX_POSITION}
          decimals={1}
          edit={set((boxWidth) => ({ boxWidth }))}
        />
      )}
      <SwitchField label="Outline" testId="text-outline" isOn={hasOutline} onSwitch={(isOn) => style(isOn ? 'Add Outline' : 'Remove Outline', { hasOutline: isOn })} />
      {hasOutline && (
        <>
          <ColorField
            label="Outline colour"
            testId="text-outline-color"
            command="Change Outline"
            value={sharedValue(clips.map((clip) => clip.outline?.color)) ?? clips[0]?.outline?.color}
            edit={withColor(
              (clip) => clip.outline?.color,
              (picked) => ({ outlineColor: picked }),
            )}
          />
          <EditField
            label="Outline width"
            testId="text-outline-width"
            command="Change Outline"
            value={sharedValue(clips.map((clip) => clip.outline?.width))}
            min={0.1}
            max={MAX_FONT_SIZE}
            decimals={1}
            edit={set((outlineWidth) => ({ outlineWidth }))}
          />
        </>
      )}
      <SwitchField label="Shadow" testId="text-shadow" isOn={hasShadow} onSwitch={(isOn) => style(isOn ? 'Add Shadow' : 'Remove Shadow', { hasShadow: isOn })} />
      {hasShadow && (
        <>
          <ColorField
            label="Shadow colour"
            testId="text-shadow-color"
            command="Change Shadow"
            value={sharedValue(clips.map((clip) => clip.shadow?.color)) ?? clips[0]?.shadow?.color}
            edit={withColor(
              (clip) => clip.shadow?.color,
              (picked) => ({ shadowColor: picked }),
            )}
          />
          <EditField
            label="Shadow X"
            testId="text-shadow-x"
            command="Change Shadow"
            value={sharedValue(clips.map((clip) => clip.shadow?.offsetX))}
            min={-MAX_FONT_SIZE}
            max={MAX_FONT_SIZE}
            decimals={1}
            edit={set((shadowOffsetX) => ({ shadowOffsetX }))}
          />
          <EditField
            label="Shadow Y"
            testId="text-shadow-y"
            command="Change Shadow"
            value={sharedValue(clips.map((clip) => clip.shadow?.offsetY))}
            min={-MAX_FONT_SIZE}
            max={MAX_FONT_SIZE}
            decimals={1}
            edit={set((shadowOffsetY) => ({ shadowOffsetY }))}
          />
          <EditField
            label="Shadow softness"
            testId="text-shadow-blur"
            command="Change Shadow"
            value={sharedValue(clips.map((clip) => clip.shadow?.blur))}
            min={0}
            max={MAX_FONT_SIZE}
            decimals={1}
            edit={set((shadowBlur) => ({ shadowBlur }))}
          />
        </>
      )}
      {boxed.length > 0 && <SwitchField label="Background box" testId="text-background" isOn={hasBackground} onSwitch={(isOn) => style(isOn ? 'Add Background' : 'Remove Background', { hasBackground: isOn })} />}
      {hasBackground && (
        <ColorField
          label="Background colour"
          testId="text-background-color"
          command="Change Background"
          value={sharedValue(boxed.map((clip) => clip.background?.color)) ?? boxed[0]?.background?.color}
          edit={withColor(
            (clip) => (clip.type === 'text' ? clip.background?.color : undefined),
            (picked) => ({ backgroundColor: picked }),
          )}
        />
      )}
    </>
  )
}

// The shape of the selected callouts, its size and its colours. Their words are in the Text group.
function CalloutFields({ clips }: { clips: readonly CalloutClip[] }): ReactElement {
  const { store } = useSession()
  const ids = clips.map((clip) => clip.id)

  function onShape(chosen: string): void {
    const shape = CALLOUT_SHAPES.find((candidate) => candidate === chosen)
    if (shape !== undefined) store.apply('Change Callout Shape', (project) => setCalloutStyle(project, ids, { shape }))
  }

  function withColor(key: 'fill' | 'borderColor'): (picked: string) => Edit {
    return (picked) => (project) => {
      let edited = project
      for (const clip of clips) edited = setCalloutStyle(edited, [clip.id], { [key]: withAlphaOf(clip[key], picked) })
      return edited
    }
  }

  return (
    <>
      <div className="labelled">
        <span className="field-label">Shape</span>
        <Picker label="Shape" testId="callout-shape" choices={CALLOUT_SHAPES.map((shape) => ({ value: shape, label: CALLOUT_NAMES[shape] }))} value={sharedValue(clips.map((clip) => clip.shape))} onChoose={onShape} />
      </div>
      <EditField
        label="Box width"
        testId="callout-width"
        command="Resize Callout"
        value={sharedValue(clips.map((clip) => clip.width))}
        min={1}
        max={MAX_POSITION}
        decimals={1}
        edit={(width) => (project) => setCalloutStyle(project, ids, { width })}
      />
      <EditField
        label="Box height"
        testId="callout-height"
        command="Resize Callout"
        value={sharedValue(clips.map((clip) => clip.height))}
        min={1}
        max={MAX_POSITION}
        decimals={1}
        edit={(height) => (project) => setCalloutStyle(project, ids, { height })}
      />
      <ColorField label="Fill" testId="callout-fill" command="Change Callout Fill" value={sharedValue(clips.map((clip) => clip.fill)) ?? clips[0]?.fill} edit={withColor('fill')} />
      <ColorField label="Border colour" testId="callout-border-color" command="Change Callout Border" value={sharedValue(clips.map((clip) => clip.borderColor)) ?? clips[0]?.borderColor} edit={withColor('borderColor')} />
      <EditField
        label="Border width"
        testId="callout-border-width"
        command="Change Callout Border"
        value={sharedValue(clips.map((clip) => clip.borderWidth))}
        min={0}
        max={MAX_FONT_SIZE}
        decimals={1}
        edit={(borderWidth) => (project) => setCalloutStyle(project, ids, { borderWidth })}
      />
    </>
  )
}

// Length, thickness, colour and the two heads of the selected arrows and lines.
function ArrowFields({ clips }: { clips: readonly ArrowClip[] }): ReactElement {
  const { store } = useSession()
  const ids = clips.map((clip) => clip.id)

  function onHead(key: 'startHead' | 'endHead', chosen: string): void {
    const head = ARROW_HEADS.find((candidate) => candidate === chosen)
    if (head !== undefined) store.apply('Change Arrow Head', (project) => setArrowStyle(project, ids, { [key]: head }))
  }

  return (
    <>
      <EditField
        label="Length"
        testId="arrow-length"
        command="Change Arrow Length"
        value={sharedValue(clips.map((clip) => clip.length))}
        min={1}
        max={MAX_POSITION}
        decimals={1}
        edit={(length) => (project) => setArrowStyle(project, ids, { length })}
      />
      <EditField
        label="Thickness"
        testId="arrow-thickness"
        command="Change Arrow Thickness"
        value={sharedValue(clips.map((clip) => clip.thickness))}
        min={1}
        max={MAX_FONT_SIZE}
        decimals={1}
        edit={(thickness) => (project) => setArrowStyle(project, ids, { thickness })}
      />
      <ColorField
        label="Colour"
        testId="arrow-color"
        command="Change Arrow Colour"
        value={sharedValue(clips.map((clip) => clip.color)) ?? clips[0]?.color}
        edit={(picked) => (project) => {
          let edited = project
          for (const clip of clips) edited = setArrowStyle(edited, [clip.id], { color: withAlphaOf(clip.color, picked) })
          return edited
        }}
      />
      {ARROW_ENDS.map(({ key, label }) => (
        <div key={key} className="labelled">
          <span className="field-label">{label}</span>
          <Picker
            label={`Head at the ${label.toLowerCase()}`}
            testId={`arrow-${key}`}
            choices={ARROW_HEADS.map((head) => ({ value: head, label: HEAD_NAMES[head] }))}
            value={sharedValue(clips.map((clip) => clip[key]))}
            onChoose={(chosen) => onHead(key, chosen)}
          />
        </div>
      ))}
    </>
  )
}

// What the selected zoom shows and how the camera gets there.
function ZoomProperties({ index }: { index: number }): ReactElement | undefined {
  const { store } = useSession()
  const zoom = useEditorState((state) => state.project.camera?.[index])
  const canvas = useEditorState((state) => state.project.canvas)
  if (zoom === undefined) return undefined
  const frameTicks = frameDuration(canvas.frameRate)
  const frameSeconds = frameTicks / TICKS_PER_SECOND

  function set(changesOf: (value: number) => ZoomChanges): (value: number) => Edit {
    return (value) => (project) => setZoom(project, index, changesOf(value), frameTicks)
  }

  function onEasing(chosen: string): void {
    const easing = EASINGS.find((entry) => entry.easing === chosen)?.easing
    if (easing !== undefined) store.apply('Change Zoom Easing', (project) => setZoom(project, index, { easing }, frameTicks))
  }

  return (
    <Group title="Zoom" icon="zoom" isOpenAtStart actions={<IconButton icon="trash" label="Delete zoom" testId="zoom-delete" onClick={() => store.apply('Delete Zoom', (project) => deleteZoom(project, index))} />}>
      <EditField
        label="Scale (%)"
        testId="zoom-scale"
        command="Change Zoom"
        value={zoom.scale * PERCENT}
        min={PERCENT}
        max={MAX_CAMERA_SCALE * PERCENT}
        decimals={1}
        presets={ZOOM_SCALES}
        edit={set((percent) => ({ scale: percent / PERCENT }))}
      />
      <EditField label="X" testId="zoom-x" command="Change Zoom" value={zoom.x} min={0} max={canvas.width} decimals={1} edit={set((x) => ({ x }))} />
      <EditField label="Y" testId="zoom-y" command="Change Zoom" value={zoom.y} min={0} max={canvas.height} decimals={1} edit={set((y) => ({ y }))} />
      <EditField
        label="Length (s)"
        testId="zoom-duration"
        command="Change Zoom Length"
        value={zoom.duration / TICKS_PER_SECOND}
        min={frameSeconds}
        max={MAX_SECONDS}
        step={frameSeconds}
        decimals={3}
        presets={MOVE_SECONDS}
        edit={set((length) => ({ duration: length * TICKS_PER_SECOND }))}
      />
      <div className="labelled">
        <span className="field-label">Easing</span>
        <Picker label="Easing" testId="zoom-easing" choices={EASINGS.map(({ easing, label }) => ({ value: easing, label }))} value={zoom.easing} onChoose={onEasing} />
      </div>
    </Group>
  )
}

// One edit made of an edit for each of the clips, one after the other.
// Each clip is read from the project the edit is given: while a value is previewed the rendered clips already hold it, so comparing against them would hand back the gesture's base unchanged.
function eachClip(clips: readonly VisualClip[], editOf: (project: Project, clip: VisualClip) => Project): Edit {
  return (project) => {
    const current = new Map(allClips(project.tracks).map((clip) => [clip.id, clip]))
    let edited = project
    for (const { id } of clips) {
      const clip = current.get(id)
      if (clip !== undefined && isVisual(clip)) edited = editOf(edited, clip)
    }
    return edited
  }
}

type InOutProps = {
  edge: TransitionEdge
  label: string
  clips: readonly VisualClip[]
  frameTicks: number
}

type ClipEnd = {
  // FADE, `animation-<type>` or the type of a transition.
  value: string
  duration: number
}

const FADE = 'fade'
const ANIMATION_PREFIX = 'animation-'
// Slides and zooms are offered as transitions, which do the same at an edge with nothing beside it; files may still hold them as animations.
const OFFERED_ANIMATIONS: readonly AnimationType[] = ['pop', 'typewriter']

// How a clip comes in or goes out. An end has one of them; files from before may hold more, and then the transition is what is shown.
function clipEnd(clip: VisualClip, edge: TransitionEdge): ClipEnd | undefined {
  const transition = edge === 'in' ? clip.transitionIn : clip.transitionOut
  if (transition !== undefined) return { value: transition.type, duration: transition.duration }
  const animation = edge === 'in' ? clip.animationIn : clip.animationOut
  if (animation !== undefined) return { value: `${ANIMATION_PREFIX}${animation.type}`, duration: animation.duration }
  const fade = edge === 'in' ? clip.fadeIn : clip.fadeOut
  if (fade !== undefined) return { value: FADE, duration: fade }
  return undefined
}

function animationOf(value: string): AnimationType | undefined {
  return ANIMATION_TYPES.find((type) => `${ANIMATION_PREFIX}${type}` === value)
}

// Setting one way in or out takes the others at that end away (see `withOnlyAtEnd`).
function withEnd(project: Project, clip: VisualClip, edge: TransitionEdge, end: ClipEnd | undefined, frameTicks: number): Project {
  const fade = edge === 'in' ? 'fadeIn' : 'fadeOut'
  if (end === undefined) {
    const withoutTransition = setTransition(project, { clipId: clip.id, edge }, undefined, frameTicks)
    return setFade(setAnimation(withoutTransition, [clip.id], edge, undefined), [clip.id], fade, 0)
  }
  if (end.value === FADE) return setFade(project, [clip.id], fade, end.duration)
  const animation = animationOf(end.value)
  if (animation !== undefined) return setAnimation(project, [clip.id], edge, { type: animation, duration: end.duration })
  const transition = TRANSITION_TYPES.find((type) => type === end.value)
  if (transition === undefined) return project
  return setTransition(project, { clipId: clip.id, edge }, { type: transition, duration: end.duration }, frameTicks)
}

// The one place a clip's fade, animation or transition at one end is chosen, and for how long.
function InOutFields({ edge, label, clips, frameTicks }: InOutProps): ReactElement {
  const { store } = useSession()
  const current = clips.map((clip) => clipEnd(clip, edge))
  const command = `Change Clip ${label}`
  const frameSeconds = frameTicks / TICKS_PER_SECOND

  const choices = [
    { value: NONE, label: 'None' },
    { value: FADE, label: 'Fade' },
  ]
  // Only what every selected clip can do is offered: a typewriter needs letters.
  for (const type of OFFERED_ANIMATIONS) {
    if (clips.every((clip) => takesAnimation(clip, type))) choices.push({ value: `${ANIMATION_PREFIX}${type}`, label: ANIMATION_NAMES[type] })
  }
  for (const type of TRANSITION_TYPES) choices.push({ value: type, label: TRANSITION_NAMES[type] })
  // An animation no longer offered is still named while a clip has it.
  for (const end of current) {
    const animation = end === undefined ? undefined : animationOf(end.value)
    const isListed = choices.some((choice) => choice.value === end?.value)
    if (end !== undefined && animation !== undefined && !isListed) choices.push({ value: end.value, label: ANIMATION_NAMES[animation] })
  }

  function onChoose(chosen: string): void {
    const edit = eachClip(clips, (project, clip) => {
      const end = clipEnd(clip, edge)
      if ((end?.value ?? NONE) === chosen) return project
      if (chosen === NONE) return withEnd(project, clip, edge, undefined, frameTicks)
      let duration = end?.duration
      if (duration === undefined) duration = TRANSITION_TYPES.some((type) => type === chosen) ? DEFAULT_TRANSITION : DEFAULT_ANIMATION
      return withEnd(project, clip, edge, { value: chosen, duration }, frameTicks)
    })
    store.apply(command, edit)
  }

  function setLength(lengthInSeconds: number): Edit {
    const duration = Math.max(1, Math.round((lengthInSeconds * TICKS_PER_SECOND) / frameTicks)) * frameTicks
    return eachClip(clips, (project, clip) => {
      const end = clipEnd(clip, edge)
      if (end === undefined || end.duration === duration) return project
      return withEnd(project, clip, edge, { value: end.value, duration }, frameTicks)
    })
  }

  return (
    <>
      <div className="labelled">
        <span className="field-label">{label}</span>
        <Picker label={`How the clip comes ${edge}`} testId={`clip-${edge}`} choices={choices} value={sharedValue(current.map((end) => end?.value ?? NONE))} onChoose={onChoose} />
      </div>
      {current.some((end) => end !== undefined) && (
        <EditField
          label={`${label} length (s)`}
          testId={`clip-${edge}-length`}
          command={command}
          value={seconds(sharedValue(current.map((end) => end?.duration)))}
          min={frameSeconds}
          max={MAX_SECONDS}
          step={frameSeconds}
          decimals={3}
          presets={MOVE_SECONDS}
          edit={setLength}
        />
      )}
    </>
  )
}

// The outline of the selected blur or highlight clips and how soft its edge is.
function ShapeFields({ clips }: { clips: readonly ShapeClip[] }): ReactElement {
  const { store } = useSession()
  const ids = clips.map((clip) => clip.id)
  const current = sharedValue(clips.map((clip) => clip.shape))
  return (
    <>
      <div className="labelled">
        <span className="field-label">Shape</span>
        <div className="segmented wide" role="group" aria-label="Shape">
          {SHAPES.map(({ shape, label }) => (
            <button key={shape} type="button" className="button" data-testid={`shape-${shape}`} aria-pressed={current === shape} onClick={() => store.apply('Change Shape', (project) => setShapeStyle(project, ids, { shape }))}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <EditField
        label="Soft edge"
        testId="shape-soft-edge"
        command="Change Soft Edge"
        value={sharedValue(clips.map((clip) => clip.softEdge))}
        min={0}
        max={MAX_POSITION}
        decimals={1}
        edit={(softEdge) => (project) => setShapeStyle(project, ids, { softEdge })}
      />
    </>
  )
}

type SwitchFieldProps = {
  label: string
  testId: string
  isOn: boolean
  onSwitch(isOn: boolean): void
}

function SwitchField({ label, testId, isOn, onSwitch }: SwitchFieldProps): ReactElement {
  return (
    <label className="check-field">
      <input type="checkbox" data-testid={testId} checked={isOn} onChange={(event) => onSwitch(event.target.checked)} />
      {label}
    </label>
  )
}

// What is said about a group that is open while nothing in it is selected, where the project settings would be.
function OpenGroupNote(): ReactElement {
  const { actions } = useSession()
  return (
    <Group title="Group" icon="group">
      <p className="hint">This group is open: the timeline shows what is inside it. Close it to change the project settings or the camera.</p>
      <button type="button" className="button" data-testid="group-close" onClick={actions.closeGroup}>
        Close group
      </button>
    </Group>
  )
}

type KeyframeButtonsProps = {
  // The selected clips that have the field.
  clips: readonly Clip[]
  set: KeyframeSet
  testId: string
}

function clipsUnder(clips: readonly Clip[], time: number): Clip[] {
  return clips.filter((clip) => time >= clip.start && time < clip.start + clip.duration)
}

// The keyframe of a field's set at the playhead, and the way to the keyframes before and after it.
// Only the clips the playhead is over are keyed: anywhere else the keyframe would land on the clip's edge.
function KeyframeButtons({ clips, set, testId }: KeyframeButtonsProps): ReactElement {
  const { store, transport } = useSession()
  const frameTicks = useEditorState((state) => frameDuration(state.project.canvas.frameRate))
  // Each is read on its own, so the buttons draw again only when what they show changes, not on every frame the playhead moves.
  const isOverClip = usePosition((position) => clipsUnder(clips, position.time).length > 0)
  const isKeyed = usePosition((position) => {
    const underPlayhead = clipsUnder(clips, position.time)
    return underPlayhead.length > 0 && underPlayhead.every((clip) => hasKeyframesAt(clip, set, position.time, frameTicks))
  })
  const previous = usePosition((position) => nearestKeyframe(clips, set, position.time, -1, frameTicks))
  const next = usePosition((position) => nearestKeyframe(clips, set, position.time, 1, frameTicks))
  const name = KEYFRAME_NAMES[set]
  const lowerName = name.toLowerCase()

  let label = `Add a ${lowerName} keyframe at the playhead`
  if (isKeyed) label = `Remove the ${lowerName} keyframe at the playhead`
  else if (!isOverClip) label = `Move the playhead over the clip to key its ${lowerName}`

  function jumpTo(target: number | undefined): void {
    if (target === undefined) return
    transport.pause()
    transport.seek(target)
  }

  function toggleKeyframe(): void {
    const { time } = transport.position()
    const ids = clipsUnder(clips, time).map((clip) => clip.id)
    store.apply(isKeyed ? `Remove ${name} Keyframe` : `Add ${name} Keyframe`, (project) => setKeyframesAt(project, ids, set, time, !isKeyed))
  }

  return (
    <>
      <IconButton icon="chevronLeft" label={`Previous ${lowerName} keyframe`} testId={`${testId}-previous-keyframe`} isDisabled={previous === undefined} onClick={() => jumpTo(previous)} />
      <IconButton
        icon="keyframe"
        label={label}
        testId={`${testId}-keyframe`}
        isPressed={isKeyed}
        isDisabled={!isOverClip}
        onClick={toggleKeyframe}
      />
      <IconButton icon="chevronRight" label={`Next ${lowerName} keyframe`} testId={`${testId}-next-keyframe`} isDisabled={next === undefined} onClick={() => jumpTo(next)} />
    </>
  )
}

function ClipProperties({ clips }: { clips: readonly Clip[] }): ReactElement {
  const mediaStates = useEditorState((state) => state.mediaStates)
  const canvas = useEditorState((state) => state.project.canvas)
  // Without keyframes every value is the same at any moment, so the fields do not draw again as the playhead moves.
  const isAnimated = clips.some((clip) => clip.keyframes !== undefined)
  const time = usePosition((position) => (isAnimated ? position.time : 0))
  const [keepsAspect, setKeepsAspect] = useState(true)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const frameTicks = frameDuration(canvas.frameRate)
  const { store, actions } = useSession()
  const visual = clips.filter(isVisual)
  const croppable = clips.filter(isCroppable)
  const worded = clips.filter(hasWords)
  const callouts = clips.filter(isCallout)
  const arrows = clips.filter(isArrow)
  const groups = clips.filter((clip) => clip.type === 'group')
  const sourced = clips.filter(hasSource)
  const loopable = clips.filter((clip) => isAnimatedImage(clip, mediaStates))
  const isLooping = loopable.length > 0 && loopable.every((clip) => clip.loop === true)
  const sounding = clips.filter((clip) => makesSound(clip, mediaStates))
  const soundingIds = sounding.map((clip) => clip.id)
  const stretched = sounding.filter(hasSource)
  const fast = stretched.filter((clip) => clip.speedPercent > FAST_SOUND_ABOVE_PERCENT)
  // A group is as large as its members make it, so it has a scale but no width or height to type.
  const hasSize = visual.some((clip) => clip.type !== 'group')
  const blurs = clips.filter(isBlur)
  const highlights = clips.filter(isHighlight)
  const isPixelated = blurs.length > 0 && blurs.every((clip) => clip.isPixelated === true)
  const isSpotlight = highlights.length > 0 && highlights.every((clip) => clip.isSpotlight === true)

  function styleShapes(label: string, style: ShapeStyle): void {
    store.apply(label, (project) => setShapeStyle(project, ids, style))
  }

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

  // A typed crop hides or reveals picture on its side as the crop tool does: the rest of the picture stays where it is.
  // It starts from the values at the playhead, so a clip whose place is animated does not jump.
  function setCrop(side: keyof Crop, property: AnimatableProperty): (value: number) => Edit {
    return (value) => (project) => {
      let edited = project
      for (const clip of croppable) {
        const natural = pictureSize(clip, mediaStates)
        if (natural === undefined) continue
        const { crop, transform } = placementAt(clip, time)
        const cropped = cropFromValue(natural, crop, transform, side, value)
        edited = setProperties(edited, [clip.id], { [property]: cropped.crop[side], x: cropped.transform.x, y: cropped.transform.y }, time)
      }
      return edited
    }
  }

  function setStart(valueInSeconds: number): Edit {
    const start = wholeFrames(valueInSeconds)
    return (project) => {
      let edited = project
      for (const clip of clips) {
        const newTrack = { id: freeTrackId(edited, `${clip.id}-track`), name: nextTrackName(edited) }
        edited = moveClips(edited, { clipIds: [clip.id], deltaTime: start - clip.start, trackShift: 0, isRipple: false, newTrack })
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
      {visual.length > 0 && (
        <Group title="Transform" icon="move" isOpenAtStart actions={<IconButton icon="link" label="Keep the aspect ratio" testId="aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />}>
          <div className="field-pair">
            <EditField label="X" testId="clip-x" command="Move Clip" value={shared('x')} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={set('x')} />
            <EditField label="Y" testId="clip-y" command="Move Clip" value={shared('y')} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={set('y')} />
            <KeyframeButtons clips={visual} set="position" testId="clip-position" />
          </div>
          {hasSize && (
            <div className="field-pair">
              <EditField label="Width" testId="clip-width" command="Resize Clip" value={sizeOf('width')} min={0} max={MAX_POSITION} decimals={1} edit={setSide('width')} />
              <EditField label="Height" testId="clip-height" command="Resize Clip" value={sizeOf('height')} min={0} max={MAX_POSITION} decimals={1} edit={setSide('height')} />
              <KeyframeButtons clips={visual} set="size" testId="clip-size" />
            </div>
          )}
          <EditField
            label="Scale (%)"
            testId="clip-scale"
            command="Resize Clip"
            value={uniformScale}
            min={0}
            max={MAX_SCALE_PERCENT}
            decimals={1}
            presets={SCALES}
            keyframes={<KeyframeButtons clips={visual} set="size" testId="clip-scale" />}
            edit={(percent) => (project) => setProperties(project, ids, { scaleX: percent / PERCENT, scaleY: percent / PERCENT }, time)}
          />
          <EditField
            label="Rotation (°)"
            testId="clip-rotation"
            command="Rotate Clip"
            value={shared('rotation')}
            min={-MAX_ROTATION}
            max={MAX_ROTATION}
            decimals={1}
            presets={ROTATIONS}
            keyframes={<KeyframeButtons clips={visual} set="rotation" testId="clip-rotation" />}
            edit={set('rotation')}
          />
        </Group>
      )}
      <Group title="Timing" icon="clock" isOpenAtStart>
        <EditField label="Start (s)" testId="clip-start" command="Move Clip" value={seconds(sharedValue(clips.map((clip) => clip.start)))} min={0} max={MAX_SECONDS} step={frameSeconds} decimals={3} edit={setStart} />
        <EditField
          label="Duration (s)"
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
              label="Source offset (s)"
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
              label="Speed (%)"
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
        {stretched.length > 0 && (
          <SwitchField
            label="Keep pitch"
            testId="clip-keep-pitch"
            isOn={stretched.every((clip) => clip.changesPitch !== true)}
            onSwitch={(isOn) => store.apply(isOn ? 'Keep Pitch' : 'Let Pitch Follow Speed', (project) => setSoundSwitches(project, ids, { changesPitch: !isOn }))}
          />
        )}
        {fast.length > 0 && (
          <SwitchField
            label="Sound above 400%"
            testId="clip-fast-sound"
            isOn={fast.every((clip) => clip.hasFastSound === true)}
            onSwitch={(isOn) => store.apply(isOn ? 'Play Fast Sound' : 'Mute Fast Sound', (project) => setSoundSwitches(project, ids, { hasFastSound: isOn }))}
          />
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
      {croppable.length > 0 && (
        <Group title="Crop" icon="crop">
          {CROP_SIDES.map(({ side, property, label }) => (
            <EditField
              key={side}
              label={label}
              testId={`clip-crop-${side}`}
              command="Crop Clip"
              value={sharedValue(croppable.map((clip) => propertyAt(clip, property, time)))}
              min={0}
              max={MAX_POSITION}
              decimals={1}
              keyframes={<KeyframeButtons clips={croppable} set="crop" testId={`clip-crop-${side}`} />}
              edit={setCrop(side, property)}
            />
          ))}
        </Group>
      )}
      {groups.length > 0 && (
        <Group title="Group" icon="group">
          <button type="button" className="button" data-testid="group-open" disabled={clips.length !== 1} onClick={actions.openGroup}>
            Open group
          </button>
          <button type="button" className="button" data-testid="group-ungroup" onClick={actions.ungroup}>
            Ungroup
          </button>
        </Group>
      )}
      {callouts.length > 0 && (
        <Group title="Callout" icon="callout">
          <CalloutFields clips={callouts} />
        </Group>
      )}
      {arrows.length > 0 && (
        <Group title="Arrow" icon="arrow">
          <ArrowFields clips={arrows} />
        </Group>
      )}
      {worded.length > 0 && (
        <Group title="Text" icon="text">
          <TextFields clips={worded} />
        </Group>
      )}
      {blurs.length > 0 && (
        <Group title="Blur" icon="blur">
          <ShapeFields clips={blurs} />
          <EditField
            label={isPixelated ? 'Block size' : 'Strength'}
            testId="blur-strength"
            command="Change Blur"
            value={sharedValue(blurs.map((clip) => clip.strength))}
            min={1}
            max={MAX_POSITION}
            decimals={1}
            edit={(strength) => (project) => setShapeStyle(project, ids, { strength })}
          />
          <SwitchField label="Pixelate" testId="blur-pixelate" isOn={isPixelated} onSwitch={(isOn) => styleShapes(isOn ? 'Pixelate' : 'Blur', { isPixelated: isOn })} />
        </Group>
      )}
      {highlights.length > 0 && (
        <Group title="Highlight" icon="marker">
          <ShapeFields clips={highlights} />
          <ColorField label="Colour" testId="highlight-color" command="Change Highlight Colour" value={sharedValue(highlights.map((clip) => clip.color))} edit={(color) => (project) => setShapeStyle(project, ids, { color })} />
          <SwitchField label="Spotlight" testId="highlight-spotlight" isOn={isSpotlight} onSwitch={(isOn) => styleShapes(isOn ? 'Make Spotlight' : 'Make Highlight', { isSpotlight: isOn })} />
        </Group>
      )}
      {visual.length > 0 && (
        <Group title="Opacity" icon="droplet">
          <EditField
            label="Opacity (%)"
            testId="clip-opacity"
            command="Change Opacity"
            value={sharedValue(visual.map((clip) => (propertyAt(clip, 'opacity', time) ?? 1) * PERCENT))}
            min={0}
            max={PERCENT}
            presets={OPACITIES}
            keyframes={<KeyframeButtons clips={visual} set="opacity" testId="clip-opacity" />}
            edit={(percent) => set('opacity')(percent / PERCENT)}
          />
        </Group>
      )}
      {visual.length > 0 && (
        <Group title="In and out" icon="transition">
          <InOutFields edge="in" label="In" clips={visual} frameTicks={frameTicks} />
          <InOutFields edge="out" label="Out" clips={visual} frameTicks={frameTicks} />
        </Group>
      )}
      {sounding.length > 0 && (
        <Group title="Volume" icon="speaker">
          <EditField
            label="Volume (%)"
            testId="clip-volume"
            command="Change Volume"
            value={sharedValue(sounding.map((clip) => (propertyAt(clip, 'volume', time) ?? 1) * PERCENT))}
            min={0}
            max={2 * PERCENT}
            presets={VOLUMES}
            keyframes={<KeyframeButtons clips={sounding} set="volume" testId="clip-volume" />}
            edit={(percent) => (project) => setProperties(project, soundingIds, { volume: percent / PERCENT }, time)}
          />
          {fadeField('Fade in (s)', 'volumeFadeIn', sounding.map((clip) => clip.volumeFadeIn))}
          {fadeField('Fade out (s)', 'volumeFadeOut', sounding.map((clip) => clip.volumeFadeOut))}
        </Group>
      )}
    </>
  )
}

export function Properties(): ReactElement | undefined {
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const selectedZoom = useEditorState((state) => state.selectedZoom)
  const isGroupOpen = useEditorState((state) => state.openGroups.length > 0)
  const clips = useMemo(() => selectedClips(project, selection), [project, selection])
  if (selectedZoom !== undefined) return <ZoomProperties index={selectedZoom} />
  if (clips.length > 0) return <ClipProperties clips={clips} />
  return isGroupOpen ? <OpenGroupNote /> : <ProjectSettings />
}
