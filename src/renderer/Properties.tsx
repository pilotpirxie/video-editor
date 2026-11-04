import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { ANIMATION_NAMES, DEFAULT_ANIMATION, setAnimation, takesAnimation } from '../editor/presets.js'
import { CALLOUT_NAMES, setArrowStyle, setCalloutStyle } from '../editor/annotations.js'
import { deleteZoom, setZoom, type ZoomChanges } from '../editor/camera.js'
import { allClips, coversTime, freeTrackId, hasMedia, hasSource, isCroppable, isContainer, isHeld, locateClip, makesSound, nextTrackName } from '../editor/clips.js'
import {
  MIN_STROKE_WIDTH,
  NEW_STROKE,
  addNodeSet,
  breakPaths,
  closePaths,
  deleteNodeSet,
  followChoices,
  followedSetOf,
  hasNodeKeysAt,
  hasSetKeysAt,
  hasShapeKeysAt,
  nodeKeyTimes,
  nodeTypeOf,
  nodesInSet,
  parentChoices,
  posedShapeAt,
  renameNodeSet,
  setKeyTimes,
  setNodeKeys,
  setNodePosition,
  setNodeSetKeys,
  setNodeSetParent,
  setNodeSetPose,
  setNodeType,
  setPoseAt,
  setShapeStroke,
  setShapesFollow,
  setShapesKeys,
  setShapesPose,
  shapeAt,
  shapeKeyTimes,
  shapePoseAt,
  strokeWith,
  type NodeRef,
  type NodeType,
  type SetPart,
  type SetRef,
  type SetValues,
  type ShapePose,
  type ShapeRef,
  type StrokeChange,
} from '../editor/drawings.js'
import { cropFromValue } from '../editor/geometry.js'
import { resolveScope } from '../editor/groups.js'
import { moveClips } from '../editor/moveTrim.js'
import {
  hasKeyframesAt,
  nearestKeyTime,
  nearestKeyframe,
  propertyAt,
  setCanvasSize,
  setDuration,
  setFade,
  setFrameRate,
  setKeyframesAt,
  holdShownFrames,
  playHeldClips,
  setHeldFrame,
  setLoop,
  setProperties,
  setSoundSwitches,
  setSourceStart,
  setSpeed,
  sharedValue,
  type ClipKeyTimes,
  type Fade,
  type KeyframeSet,
  type PropertyValues,
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
  ANIMATION_PRESET_TYPES,
  ARROW_HEADS,
  CALLOUT_SHAPES,
  MAX_CAMERA_SCALE,
  MAX_CANVAS,
  MIN_CANVAS,
  TRANSITION_TYPES,
  isVisual,
  projectDuration,
  type AnimatableProperty,
  type AnimationClip,
  type AudioClip,
  type AnimationPresetType,
  type ArrowClip,
  type ArrowHead,
  type BlurClip,
  type CalloutClip,
  type Clip,
  type Crop,
  type DrawingClip,
  type DrawingShape,
  type Easing,
  type HighlightClip,
  type NodeSet,
  type Project,
  type Shape,
  type ShapeClip,
  type ShapeNode,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
  type TextAlign,
  type TextClip,
  type Transform,
  type VideoClip,
  type VisualClip,
} from '../shared/project.js'
import { ANIMATION_FRAME_RATES, FAST_SOUND_ABOVE_PERCENT, MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, PROJECT_FRAME_RATES, TICKS_PER_SECOND, frameDuration, type FrameRate } from '../shared/time.js'
import { ColorFields, DraftField } from './ColorFields.js'
import { useEditorState, usePosition, useSession, useThumbnailUpdates } from './context.js'
import { installedFontFamilies } from './fonts.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { Poster } from './MediaTab.js'
import { PopupMenu } from './Menu.js'
import { NumberField } from './NumberField.js'
import { Picker, type Choice } from './Picker.js'
import { updateStep, type Edit, type EditorState } from './store.js'
import { endTextEdit, typeText } from './TextEditor.js'

const FRAME_RATE_DECIMALS = 3
const SECONDS_DECIMALS = 3
const PERCENT = 100
const MAX_VOLUME_PERCENT = 200
const MIN_OUTLINE_WIDTH = 0.1
const MAX_POSITION = 100_000
const MAX_SECONDS = 24 * 60 * 60
const MAX_ROTATION = 36_000
const MAX_SCALE_PERCENT = 10_000
const MIN_SET_SCALE_PERCENT = 1
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
const SHAPES: readonly SegmentChoice<Shape>[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
]
const STROKE_STYLES: readonly SegmentChoice<'none' | 'solid' | 'dashed'>[] = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
]
const STROKE_CAPS: readonly SegmentChoice<StrokeCap>[] = [
  { value: 'butt', label: 'Butt' },
  { value: 'round', label: 'Round' },
  { value: 'square', label: 'Square' },
]
const STROKE_JOINS: readonly SegmentChoice<StrokeJoin>[] = [
  { value: 'miter', label: 'Mitre' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
]
const STROKE_ALIGNS: readonly SegmentChoice<StrokeAlign>[] = [
  { value: 'inside', label: 'Inside' },
  { value: 'center', label: 'Centre' },
  { value: 'outside', label: 'Outside' },
]
const STROKE_ORDERS: readonly SegmentChoice<'behind' | 'front'>[] = [
  { value: 'behind', label: 'Behind' },
  { value: 'front', label: 'Front' },
]
const MAX_STROKE_WIDTH = 1000
const NODE_TYPES: readonly SegmentChoice<NodeType>[] = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'smooth', label: 'Smooth' },
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
  actions?: ReactElement
  isOpenAtStart?: boolean
  children: ReactNode
}

type ColorFieldProps = {
  label: string
  testId: string
  command: string
  value: string | undefined
  edit(color: string): Edit
}

export function ColorField({ label, testId, command, value, edit }: ColorFieldProps): ReactElement {
  const { store } = useSession()
  const fieldRef = useRef<HTMLInputElement>(null)
  const isPickingRef = useRef(false)

  useEffect(() => {
    const field = fieldRef.current
    if (field === null) return
    function endPicking(): void {
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

  const opaqueColor = (value ?? '').slice(0, OPAQUE_COLOR_LENGTH)
  return (
    <label className="labelled">
      <span className="field-label">{label}</span>
      <input ref={fieldRef} className="color-field" type="color" data-testid={testId} value={opaqueColor} onChange={(event) => onColor(event.target.value)} />
    </label>
  )
}

export function Group({ title, icon, actions, isOpenAtStart = false, children }: GroupProps): ReactElement {
  const storageKey = `group-${title}`
  const [isOpen, setIsOpen] = useState(() => {
    const stored = sessionStorage.getItem(storageKey)
    if (stored === null) return isOpenAtStart
    return stored === 'open'
  })

  function toggle(): void {
    setIsOpen(!isOpen)
    try {
      sessionStorage.setItem(storageKey, isOpen ? 'closed' : 'open')
    } catch (error) {
      logError('Could not remember which groups are folded', error)
    }
  }

  const toggleTestId = `group-${title.toLowerCase().replaceAll(' ', '-')}`
  return (
    <section className="group" aria-label={title}>
      <div className="group-header">
        <button type="button" className="group-toggle focusable" aria-expanded={isOpen} data-testid={toggleTestId} onClick={toggle}>
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

type CanvasSettingsProps = {
  title: 'Project' | 'Animation'
  frameRates: readonly FrameRate[]
}

function CanvasSettings({ title, frameRates }: CanvasSettingsProps): ReactElement {
  const { store } = useSession()
  const canvas = useEditorState((state) => state.project.canvas)
  const [keepsAspect, setKeepsAspect] = useState(true)

  function onFrameRate(key: string): void {
    const chosen = frameRates.find((rate) => rateKey(rate) === key)
    if (chosen !== undefined) store.apply('Change Frame Rate', (project) => setFrameRate(project, chosen))
  }

  function setSide(side: 'width' | 'height'): (value: number) => Edit {
    return (value) => (project) => {
      const { width, height } = project.canvas
      if (side === 'width') {
        const keptHeight = keepsAspect ? (value * height) / width : height
        return setCanvasSize(project, { width: value, height: keptHeight })
      }
      const keptWidth = keepsAspect ? (value * width) / height : width
      return setCanvasSize(project, { width: keptWidth, height: value })
    }
  }

  const aspectLock = <IconButton icon="link" label="Keep the aspect ratio" testId="canvas-aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />
  return (
    <Group title={title} icon={title === 'Project' ? 'film' : 'animation'} isOpenAtStart actions={aspectLock}>
      <EditField label="Width" testId="canvas-width" command="Change Canvas Size" value={canvas.width} min={MIN_CANVAS.width} max={MAX_CANVAS.width} edit={setSide('width')} />
      <EditField label="Height" testId="canvas-height" command="Change Canvas Size" value={canvas.height} min={MIN_CANVAS.height} max={MAX_CANVAS.height} edit={setSide('height')} />
      <div className="labelled">
        <span className="field-label">Frame rate</span>
        <Picker
          label="Frame rate"
          testId="frame-rate"
          choices={frameRates.map((rate) => ({ value: rateKey(rate), label: rateLabel(rate) }))}
          value={rateKey(canvas.frameRate)}
          onChoose={onFrameRate}
        />
      </div>
    </Group>
  )
}

function isAnimationRootOpen(state: EditorState): boolean {
  if (state.openDocument === undefined) return false
  return resolveScope(state.wholeProject, state.documents, state.mediaStates, state.openGroups).groupsInDocument.length === 0
}

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

function pictureSize(clip: Clip, mediaStates: MediaStates): Size | undefined {
  if (!hasMedia(clip) || clip.type === 'audio') return undefined
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state) return undefined
  if (state.info.kind === 'video') return state.info.video
  if (state.info.kind === 'image') return state.info
  return undefined
}

function shownSize(clip: Clip, mediaStates: MediaStates, time: number): Size | undefined {
  if (clip.type === 'text') {
    const measured = measureText(clip)
    return { width: measured.naturalWidth, height: measured.naturalHeight }
  }
  if (clip.type === 'blur' || clip.type === 'highlight' || clip.type === 'callout') return { width: clip.width, height: clip.height }
  if (clip.type === 'arrow') return arrowSize(clip)
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

function withAlphaOf(current: string | undefined, picked: string): string {
  return `${picked}${(current ?? '').slice(OPAQUE_COLOR_LENGTH)}`
}

function placementAt(clip: Clip, time: number): { crop: Crop; transform: Transform } {
  function at(property: AnimatableProperty): number {
    return propertyAt(clip, property, time) ?? 0
  }
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

function playsSource(clip: Clip): clip is VideoClip | AudioClip | AnimationClip {
  return hasSource(clip) && !isHeld(clip)
}

function isLoopable(clip: Clip, mediaStates: MediaStates): clip is VideoClip | AnimationClip {
  if (clip.type === 'animation') return !isHeld(clip)
  if (clip.type !== 'video') return false
  const state = mediaStates[clip.mediaId]
  if (state === undefined || !('info' in state)) return false
  return state.info.kind === 'video' && state.info.isAnimatedImage === true
}

type WordsClip = TextClip | CalloutClip

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

  function wrap(isOn: boolean): void {
    const command = isOn ? 'Wrap Text' : 'Stop Wrapping Text'
    store.apply(command, (project) => {
      let edited = project
      for (const clip of boxed) {
        const boxWidth = isOn ? Math.ceil(measureText(clip).naturalWidth) : 'auto'
        edited = setTextStyle(edited, [clip.id], { boxWidth })
      }
      return edited
    })
  }

  function switchOutline(isOn: boolean): void {
    style(isOn ? 'Add Outline' : 'Remove Outline', { hasOutline: isOn })
  }

  function switchShadow(isOn: boolean): void {
    style(isOn ? 'Add Shadow' : 'Remove Shadow', { hasShadow: isOn })
  }

  function switchBackground(isOn: boolean): void {
    style(isOn ? 'Add Background' : 'Remove Background', { hasBackground: isOn })
  }

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

  function withColor(colorOf: (clip: WordsClip) => string | undefined, styleOf: (color: string) => TextStyle): (picked: string) => Edit {
    return (picked) => (project) => {
      let edited = project
      for (const clip of clips) {
        const color = withAlphaOf(colorOf(clip), picked)
        edited = setTextStyle(edited, [clip.id], styleOf(color))
      }
      return edited
    }
  }

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

  const fontNames = new Set(installed)
  for (const clip of clips) fontNames.add(clip.font.family)
  const families = [...fontNames].sort((a, b) => a.localeCompare(b))
  const missing = installed.length === 0 ? [] : missingFonts(clips, installed)
  const fontChoices: Choice[] = []
  for (const name of families) {
    const label = missing.includes(name) ? `${name} (not installed)` : name
    fontChoices.push({ value: name, label })
  }
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
          choices={fontChoices}
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
      <SwitchField label="Outline" testId="text-outline" isOn={hasOutline} onSwitch={switchOutline} />
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
            min={MIN_OUTLINE_WIDTH}
            max={MAX_FONT_SIZE}
            decimals={1}
            edit={set((outlineWidth) => ({ outlineWidth }))}
          />
        </>
      )}
      <SwitchField label="Shadow" testId="text-shadow" isOn={hasShadow} onSwitch={switchShadow} />
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
      {boxed.length > 0 && <SwitchField label="Background box" testId="text-background" isOn={hasBackground} onSwitch={switchBackground} />}
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

  const fill = sharedValue(clips.map((clip) => clip.fill)) ?? clips[0]?.fill
  const borderColor = sharedValue(clips.map((clip) => clip.borderColor)) ?? clips[0]?.borderColor
  return (
    <>
      <div className="labelled">
        <span className="field-label">Shape</span>
        <Picker
          label="Shape"
          testId="callout-shape"
          choices={CALLOUT_SHAPES.map((shape) => ({ value: shape, label: CALLOUT_NAMES[shape] }))}
          value={sharedValue(clips.map((clip) => clip.shape))}
          onChoose={onShape}
        />
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
      <ColorField label="Fill" testId="callout-fill" command="Change Callout Fill" value={fill} edit={withColor('fill')} />
      <ColorField label="Border colour" testId="callout-border-color" command="Change Callout Border" value={borderColor} edit={withColor('borderColor')} />
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
          for (const clip of clips) {
            const color = withAlphaOf(clip.color, picked)
            edited = setArrowStyle(edited, [clip.id], { color })
          }
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

  function removeZoom(): void {
    store.apply('Delete Zoom', (project) => deleteZoom(project, index))
  }

  const deleteButton = <IconButton icon="trash" label="Delete zoom" testId="zoom-delete" onClick={removeZoom} />
  return (
    <Group title="Zoom" icon="zoom" isOpenAtStart actions={deleteButton}>
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
        decimals={SECONDS_DECIMALS}
        presets={MOVE_SECONDS}
        edit={set((length) => ({ duration: length * TICKS_PER_SECOND }))}
      />
      <div className="labelled">
        <span className="field-label">Easing</span>
        <Picker
          label="Easing"
          testId="zoom-easing"
          choices={EASINGS.map(({ easing, label }) => ({ value: easing, label }))}
          value={zoom.easing}
          onChoose={onEasing}
        />
      </div>
    </Group>
  )
}

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
  value: string
  duration: number
}

const FADE = 'fade'
const ANIMATION_PREFIX = 'animation-'
const OFFERED_ANIMATIONS: readonly AnimationPresetType[] = ['pop', 'typewriter']

function clipEnd(clip: VisualClip, edge: TransitionEdge): ClipEnd | undefined {
  const transition = edge === 'in' ? clip.transitionIn : clip.transitionOut
  if (transition !== undefined) return { value: transition.type, duration: transition.duration }
  const animation = edge === 'in' ? clip.animationIn : clip.animationOut
  if (animation !== undefined) return { value: `${ANIMATION_PREFIX}${animation.type}`, duration: animation.duration }
  const fade = edge === 'in' ? clip.fadeIn : clip.fadeOut
  if (fade !== undefined) return { value: FADE, duration: fade }
  return undefined
}

function animationOf(value: string): AnimationPresetType | undefined {
  return ANIMATION_PRESET_TYPES.find((type) => `${ANIMATION_PREFIX}${type}` === value)
}

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

function InOutFields({ edge, label, clips, frameTicks }: InOutProps): ReactElement {
  const { store } = useSession()
  const current = clips.map((clip) => clipEnd(clip, edge))
  const command = `Change Clip ${label}`
  const frameSeconds = frameTicks / TICKS_PER_SECOND

  const choices = [
    { value: NONE, label: 'None' },
    { value: FADE, label: 'Fade' },
  ]
  for (const type of OFFERED_ANIMATIONS) {
    const isTakenByAll = clips.every((clip) => takesAnimation(clip, type))
    if (isTakenByAll) choices.push({ value: `${ANIMATION_PREFIX}${type}`, label: ANIMATION_NAMES[type] })
  }
  for (const type of TRANSITION_TYPES) choices.push({ value: type, label: TRANSITION_NAMES[type] })
  for (const end of current) {
    if (end === undefined) continue
    const animation = animationOf(end.value)
    const isListed = choices.some((choice) => choice.value === end.value)
    if (animation !== undefined && !isListed) choices.push({ value: end.value, label: ANIMATION_NAMES[animation] })
  }

  function onChoose(chosen: string): void {
    const edit = eachClip(clips, (project, clip) => {
      const end = clipEnd(clip, edge)
      if ((end?.value ?? NONE) === chosen) return project
      if (chosen === NONE) return withEnd(project, clip, edge, undefined, frameTicks)
      let duration = end?.duration
      if (duration === undefined) {
        const isTransition = TRANSITION_TYPES.some((type) => type === chosen)
        duration = isTransition ? DEFAULT_TRANSITION : DEFAULT_ANIMATION
      }
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
        <Picker
          label={`How the clip comes ${edge}`}
          testId={`clip-${edge}`}
          choices={choices}
          value={sharedValue(current.map((end) => end?.value ?? NONE))}
          onChoose={onChoose}
        />
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
          decimals={SECONDS_DECIMALS}
          presets={MOVE_SECONDS}
          edit={setLength}
        />
      )}
    </>
  )
}

type SegmentChoice<Value extends string> = {
  value: Value
  label: string
}

type ChoiceFieldProps<Value extends string> = {
  label: string
  testId: string
  choices: readonly SegmentChoice<Value>[]
  value: Value | undefined
  onChoose(value: Value): void
}

function ChoiceField<Value extends string>({ label, testId, choices, value, onChoose }: ChoiceFieldProps<Value>): ReactElement {
  return (
    <div className="labelled">
      <span className="field-label">{label}</span>
      <div className="segmented wide" role="group" aria-label={label}>
        {choices.map((choice) => (
          <button key={choice.value} type="button" className="button" data-testid={`${testId}-${choice.value}`} aria-pressed={value === choice.value} onClick={() => onChoose(choice.value)}>
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ShapeFields({ clips }: { clips: readonly ShapeClip[] }): ReactElement {
  const { store } = useSession()
  const ids = clips.map((clip) => clip.id)
  const current = sharedValue(clips.map((clip) => clip.shape))

  function chooseShape(shape: Shape): void {
    store.apply('Change Shape', (project) => setShapeStyle(project, ids, { shape }))
  }

  return (
    <>
      <ChoiceField label="Shape" testId="shape" choices={SHAPES} value={current} onChoose={chooseShape} />
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

// Sets the chosen shapes as one undo step per drag, and the stroke new shapes get; with no shape chosen it sets only that stroke.
function StrokeFields(): ReactElement {
  const { store } = useSession()
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const firstShape = useEditorState((state) => {
    const first = state.selectedShapes[0]
    return first === undefined ? undefined : shapeAt(state.project, first)
  })
  const pendingRef = useRef<StrokeChange | 'none' | undefined>(undefined)
  const isEditingShapes = selectedShapes.length > 0
  const stroke = isEditingShapes ? firstShape?.stroke : drawingStyle.stroke
  const base = drawingStyle.stroke ?? NEW_STROKE

  function newShapesStroke(change: StrokeChange | 'none'): void {
    store.setDrawingStroke(change === 'none' ? undefined : strokeWith(base, change))
  }

  function begin(): void {
    if (isEditingShapes) store.begin('Change Stroke')
  }

  function change(next: StrokeChange | 'none'): void {
    pendingRef.current = next
    if (isEditingShapes) store.update((project) => setShapeStroke(project, selectedShapes, next, base))
    else newShapesStroke(next)
  }

  function commit(): void {
    if (isEditingShapes) store.commit()
    const next = pendingRef.current
    pendingRef.current = undefined
    if (next !== undefined && isEditingShapes) newShapesStroke(next)
  }

  function cancel(): void {
    pendingRef.current = undefined
    if (isEditingShapes) store.cancel()
  }

  function changeOnce(next: StrokeChange | 'none'): void {
    begin()
    change(next)
    commit()
  }

  let style: 'none' | 'solid' | 'dashed' = 'none'
  if (stroke !== undefined) style = stroke.isDashed === true ? 'dashed' : 'solid'
  return (
    <>
      <ChoiceField label="Style" testId="stroke-style" choices={STROKE_STYLES} value={style} onChoose={(chosen) => changeOnce(chosen === 'none' ? 'none' : { isDashed: chosen === 'dashed' })} />
      {stroke !== undefined && (
        <>
          <NumberField
            label="Width (px)"
            testId="stroke-width"
            value={stroke.width}
            min={MIN_STROKE_WIDTH}
            max={MAX_STROKE_WIDTH}
            decimals={1}
            onBegin={begin}
            onChange={(width) => change({ width })}
            onCommit={commit}
            onCancel={cancel}
          />
          <ChoiceField label="Cap" testId="stroke-cap" choices={STROKE_CAPS} value={stroke.cap ?? 'round'} onChoose={(cap) => changeOnce({ cap })} />
          <ChoiceField label="Join" testId="stroke-join" choices={STROKE_JOINS} value={stroke.join ?? 'round'} onChoose={(join) => changeOnce({ join })} />
          <ChoiceField label="Align" testId="stroke-align" choices={STROKE_ALIGNS} value={stroke.align ?? 'center'} onChoose={(align) => changeOnce({ align })} />
          <ChoiceField label="Order" testId="stroke-order" choices={STROKE_ORDERS} value={stroke.isBehind === true ? 'behind' : 'front'} onChoose={(order) => changeOnce({ isBehind: order === 'behind' })} />
          <SwitchField label="Scale with object" testId="stroke-scales" isOn={stroke.scalesWithObject === true} onSwitch={(isOn) => changeOnce({ scalesWithObject: isOn })} />
        </>
      )}
    </>
  )
}

type SetMenu = {
  at: { x: number; y: number }
  set: SetRef
}

function isSameSet(first: SetRef | undefined, second: SetRef): boolean {
  return first?.clipId === second.clipId && first.setId === second.setId
}

const SET_CHOICE_PREFIX = 'set:'

function setChoices(sets: readonly NodeSet[]): Choice[] {
  const choices: Choice[] = [{ value: NONE, label: 'None' }]
  for (const set of sets) choices.push({ value: `${SET_CHOICE_PREFIX}${set.id}`, label: set.name })
  return choices
}

function setChoiceOf(setId: string | undefined): string {
  return setId === undefined ? NONE : `${SET_CHOICE_PREFIX}${setId}`
}

function chosenSetId(choice: string): string | undefined {
  return choice.startsWith(SET_CHOICE_PREFIX) ? choice.slice(SET_CHOICE_PREFIX.length) : undefined
}

function useChosenNodes(): { project: Project; selectedShapes: readonly ShapeRef[]; selectedNodes: readonly NodeRef[] } {
  const project = useEditorState((state) => state.project)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const selectedNodes = useEditorState((state) => state.selectedNodes)
  return { project, selectedShapes, selectedNodes }
}

// The sets of the chosen shapes' drawings as pills; a pill chooses the set's nodes, and Save makes a set of the chosen nodes of one shape.
function NodeSetFields(): ReactElement {
  const { store, transport } = useSession()
  const { project, selectedShapes, selectedNodes } = useChosenNodes()
  const selectedSet = useEditorState((state) => state.selectedSet)
  const [menu, setMenu] = useState<SetMenu | undefined>(undefined)
  const drawings: DrawingClip[] = []
  for (const { clipId } of selectedShapes) {
    const clip = locateClip(project, clipId)?.clip
    if (clip?.type === 'drawing' && !drawings.includes(clip)) drawings.push(clip)
  }
  const chosenShapes = new Set(selectedNodes.map((node) => `${node.clipId}/${node.shapeId}`))
  const canSave = chosenShapes.size === 1
  const [onlyDrawing] = drawings
  const chosen: DrawingShape[] = []
  for (const ref of selectedShapes) {
    const shape = shapeAt(project, ref)
    if (shape !== undefined) chosen.push(shape)
  }
  const followed = drawings.length === 1 && onlyDrawing?.nodeSets !== undefined ? onlyDrawing : undefined
  const shownDrawing = drawings.find((clip) => clip.id === selectedSet?.clipId)
  const shownSet = selectedSet === undefined || shownDrawing === undefined ? undefined : shownDrawing.nodeSets?.find((set) => set.id === selectedSet.setId)
  const rotation = usePosition((position) => (shownDrawing === undefined || shownSet === undefined ? undefined : setPoseAt(shownDrawing, shownSet.id, position.time - shownDrawing.start)?.rotation))
  const moveX = usePosition((position) => (shownDrawing === undefined || shownSet === undefined ? undefined : setPoseAt(shownDrawing, shownSet.id, position.time - shownDrawing.start)?.x))
  const moveY = usePosition((position) => (shownDrawing === undefined || shownSet === undefined ? undefined : setPoseAt(shownDrawing, shownSet.id, position.time - shownDrawing.start)?.y))
  const scale = usePosition((position) => (shownDrawing === undefined || shownSet === undefined ? undefined : setPoseAt(shownDrawing, shownSet.id, position.time - shownDrawing.start)?.scale))
  const scalePercent = scale === undefined ? undefined : scale * PERCENT

  function choose(clip: DrawingClip, setId: string): void {
    const nodes = nodesInSet(clip, setId)
    const shapes: ShapeRef[] = []
    for (const node of nodes) {
      if (!shapes.some((shape) => shape.shapeId === node.shapeId)) shapes.push({ clipId: node.clipId, shapeId: node.shapeId })
    }
    store.selectSet({ clipId: clip.id, setId }, shapes, nodes)
  }

  function save(): void {
    const nodes = selectedNodes
    const first = nodes[0]
    if (first === undefined) return
    const setId = crypto.randomUUID()
    const time = transport.position().time
    store.apply('Save Node Set', (current) => addNodeSet(current, nodes, setId, time))
    store.selectSet({ clipId: first.clipId, setId }, [{ clipId: first.clipId, shapeId: first.shapeId }], nodes)
  }

  function follow(choice: string): void {
    const setId = chosenSetId(choice)
    store.apply(setId === undefined ? 'Stop Following' : 'Follow Node Set', (current) => setShapesFollow(current, selectedShapes, setId))
  }

  function openMenu(event: MouseEvent<HTMLButtonElement>, set: SetRef): void {
    event.preventDefault()
    setMenu({ at: { x: event.clientX, y: event.clientY }, set })
  }

  const posed = (values: SetValues, set: SetRef): Edit => (current) => setNodeSetPose(current, set, values, transport.position().time)
  return (
    <>
      <div className="labelled">
        <span className="field-label">Node sets</span>
        <div className="pill-row" role="group" aria-label="Node sets">
          {drawings.map((clip) =>
            (clip.nodeSets ?? []).map((set) => {
              const ref = { clipId: clip.id, setId: set.id }
              return (
                <button
                  key={`${clip.id}/${set.id}`}
                  type="button"
                  className="button"
                  aria-pressed={isSameSet(selectedSet, ref)}
                  data-testid={`node-set-${set.name}`}
                  onClick={() => choose(clip, set.id)}
                  onContextMenu={(event) => openMenu(event, ref)}
                >
                  {set.name}
                </button>
              )
            }),
          )}
          <button type="button" className="button with-icon" data-testid="node-set-save" disabled={!canSave} onClick={save}>
            <Icon name="plus" />
            Save selection
          </button>
        </div>
      </div>
      {followed !== undefined && (
        <div className="labelled">
          <span className="field-label">Follow</span>
          <Picker
            label="Follow"
            testId="shape-follow"
            choices={setChoices(followChoices(followed, chosen))}
            value={sharedValue(chosen.map((shape) => setChoiceOf(followedSetOf(followed, shape))))}
            onChoose={follow}
          />
        </div>
      )}
      {selectedSet !== undefined && shownDrawing !== undefined && shownSet !== undefined && (
        <>
          <DraftField
            key={shownSet.id}
            label="Name"
            testId="node-set-name"
            value={shownSet.name}
            onApply={(name) => store.apply('Rename Node Set', (current) => renameNodeSet(current, selectedSet, name))}
          />
          <div className="labelled">
            <span className="field-label">Parent</span>
            <Picker
              label="Parent"
              testId="node-set-parent"
              choices={setChoices(parentChoices(shownDrawing, shownSet.id))}
              value={setChoiceOf(shownSet.parent)}
              onChoose={(choice) => store.apply('Change Parent Set', (current) => setNodeSetParent(current, selectedSet, chosenSetId(choice)))}
            />
          </div>
          <EditField
            label="Rotation (°)"
            testId="node-set-rotation"
            command="Rotate Node Set"
            value={rotation}
            min={-MAX_ROTATION}
            max={MAX_ROTATION}
            decimals={1}
            keyframes={<SetKeyButtons set={selectedSet} part="rotation" testId="node-set-rotation" />}
            edit={(value) => posed({ rotation: value }, selectedSet)}
          />
          <EditField
            label="Scale (%)"
            testId="node-set-scale"
            command="Scale Node Set"
            value={scalePercent}
            min={MIN_SET_SCALE_PERCENT}
            max={MAX_SCALE_PERCENT}
            decimals={1}
            keyframes={<SetKeyButtons set={selectedSet} part="scale" testId="node-set-scale" />}
            edit={(value) => posed({ scale: value / PERCENT }, selectedSet)}
          />
          <div className="field-pair">
            <EditField label="X" testId="node-set-x" command="Move Node Set" value={moveX} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={(value) => posed({ x: value }, selectedSet)} />
            <EditField label="Y" testId="node-set-y" command="Move Node Set" value={moveY} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={(value) => posed({ y: value }, selectedSet)} />
            <SetKeyButtons set={selectedSet} part="position" testId="node-set-position" />
          </div>
        </>
      )}
      {menu !== undefined && (
        <PopupMenu
          label="Node set"
          items={[{ label: 'Delete Node Set', testId: 'menu-delete-node-set', onSelect: () => store.apply('Delete Node Set', (current) => deleteNodeSet(current, menu.set)) }]}
          at={menu.at}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  )
}

// Type and place show what the chosen nodes share where they show at the playhead; Close and Break act on the chosen shapes and nodes.
function NodeFields(): ReactElement {
  const { store, transport } = useSession()
  const { project, selectedShapes, selectedNodes } = useChosenNodes()
  const shownAt = (axis: 'x' | 'y', time: number): number | undefined => {
    const shown: number[] = []
    for (const ref of selectedNodes) {
      const node = posedShapeAt(project, ref, time)?.nodes[ref.index]
      if (node !== undefined) shown.push(node[axis])
    }
    return sharedValue(shown)
  }
  const shownX = usePosition((position) => shownAt('x', position.time))
  const shownY = usePosition((position) => shownAt('y', position.time))
  const chosen: ShapeNode[] = []
  for (const ref of selectedNodes) {
    const node = shapeAt(project, ref)?.nodes[ref.index]
    if (node !== undefined) chosen.push(node)
  }
  let hasOpenShape = false
  for (const ref of selectedShapes) {
    if (shapeAt(project, ref)?.isClosed !== true) hasOpenShape = true
  }
  const moveCommand = selectedNodes.length === 1 ? 'Move Node' : 'Move Nodes'

  function chooseType(type: NodeType): void {
    store.apply('Change Node Type', (current) => setNodeType(current, selectedNodes, type))
  }

  // The parts are new paths, so the chosen nodes no longer point at the same places.
  function breakChosen(): void {
    store.apply('Break Path', (current) => breakPaths(current, selectedNodes, () => crypto.randomUUID()))
    store.selectNodes([])
  }

  return (
    <>
      <NodeSetFields />
      {chosen.length > 0 && (
        <>
          <ChoiceField label="Type" testId="node-type" choices={NODE_TYPES} value={sharedValue(chosen.map(nodeTypeOf))} onChoose={chooseType} />
          <div className="field-pair">
            <EditField
              label="X"
              testId="node-x"
              command={moveCommand}
              value={shownX}
              min={-MAX_POSITION}
              max={MAX_POSITION}
              decimals={1}
              edit={(x) => (current) => setNodePosition(current, selectedNodes, 'x', x, transport.position().time)}
            />
            <EditField
              label="Y"
              testId="node-y"
              command={moveCommand}
              value={shownY}
              min={-MAX_POSITION}
              max={MAX_POSITION}
              decimals={1}
              edit={(y) => (current) => setNodePosition(current, selectedNodes, 'y', y, transport.position().time)}
            />
            <NodeKeyButtons nodes={selectedNodes} />
          </div>
        </>
      )}
      <button type="button" className="button" data-testid="node-close" disabled={!hasOpenShape} onClick={() => store.apply('Close Path', (current) => closePaths(current, selectedShapes))}>
        Close path
      </button>
      <button type="button" className="button" data-testid="node-break" disabled={selectedNodes.length === 0} onClick={breakChosen}>
        Break path
      </button>
    </>
  )
}

function PenFields(): ReactElement {
  const { store } = useSession()
  const isFillingOpenPaths = useEditorState((state) => state.isFillingOpenPaths)
  return <SwitchField label="Fill open paths" testId="pen-fill-open" isOn={isFillingOpenPaths} onSwitch={store.setFillingOpenPaths} />
}

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
  clips: readonly Clip[]
  set: KeyframeSet
  testId: string
}

function clipsUnder(clips: readonly Clip[], time: number): Clip[] {
  return clips.filter((clip) => coversTime(clip, time))
}

type KeyNavigationProps = {
  name: string
  testId: string
  isOverClip: boolean
  isKeyed: boolean
  previous: number | undefined
  next: number | undefined
  onToggle(time: number): void
}

function KeyNavigation({ name, testId, isOverClip, isKeyed, previous, next, onToggle }: KeyNavigationProps): ReactElement {
  const { transport } = useSession()
  const lowerName = name.toLowerCase()

  let label = `Add a ${lowerName} keyframe at the playhead`
  if (isKeyed) label = `Remove the ${lowerName} keyframe at the playhead`
  else if (!isOverClip) label = `Move the playhead over the clip to key its ${lowerName}`

  function jumpTo(target: number | undefined): void {
    if (target === undefined) return
    transport.pause()
    transport.seek(target)
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
        onClick={() => onToggle(transport.position().time)}
      />
      <IconButton icon="chevronRight" label={`Next ${lowerName} keyframe`} testId={`${testId}-next-keyframe`} isDisabled={next === undefined} onClick={() => jumpTo(next)} />
    </>
  )
}

function KeyframeButtons({ clips, set, testId }: KeyframeButtonsProps): ReactElement {
  const { store } = useSession()
  const frameTicks = useEditorState((state) => frameDuration(state.project.canvas.frameRate))
  const isOverClip = usePosition((position) => clipsUnder(clips, position.time).length > 0)
  const isKeyed = usePosition((position) => {
    const underPlayhead = clipsUnder(clips, position.time)
    return underPlayhead.length > 0 && underPlayhead.every((clip) => hasKeyframesAt(clip, set, position.time, frameTicks))
  })
  const previous = usePosition((position) => nearestKeyframe(clips, set, position.time, -1, frameTicks))
  const next = usePosition((position) => nearestKeyframe(clips, set, position.time, 1, frameTicks))
  const name = KEYFRAME_NAMES[set]

  function toggle(time: number): void {
    const ids = clipsUnder(clips, time).map((clip) => clip.id)
    const command = isKeyed ? `Remove ${name} Keyframe` : `Add ${name} Keyframe`
    store.apply(command, (project) => setKeyframesAt(project, ids, set, time, !isKeyed))
  }

  return <KeyNavigation name={name} testId={testId} isOverClip={isOverClip} isKeyed={isKeyed} previous={previous} next={next} onToggle={toggle} />
}

type DrawingKeyButtonsProps = {
  name: string
  testId: string
  entries: readonly ClipKeyTimes[]
  isKeyedAt(time: number): boolean
  edit(time: number, isKeyed: boolean): Edit
}

// Keys of nodes and node sets, which live on drawings rather than on clip properties.
function DrawingKeyButtons({ name, testId, entries, isKeyedAt, edit }: DrawingKeyButtonsProps): ReactElement {
  const { store } = useSession()
  const frameTicks = useEditorState((state) => frameDuration(state.project.canvas.frameRate))
  const clips = entries.map((entry) => entry.clip)
  const isOverClip = usePosition((position) => clips.length > 0 && clipsUnder(clips, position.time).length === clips.length)
  const isKeyed = usePosition((position) => isKeyedAt(position.time))
  const previous = usePosition((position) => nearestKeyTime(entries, position.time, -1, frameTicks))
  const next = usePosition((position) => nearestKeyTime(entries, position.time, 1, frameTicks))
  const command = isKeyed ? `Remove ${name} Keyframe` : `Add ${name} Keyframe`
  return <KeyNavigation name={name} testId={testId} isOverClip={isOverClip} isKeyed={isKeyed} previous={previous} next={next} onToggle={(time) => store.apply(command, edit(time, !isKeyed))} />
}

function NodeKeyButtons({ nodes }: { nodes: readonly NodeRef[] }): ReactElement {
  const project = useEditorState((state) => state.project)
  const entries = useMemo(() => nodeKeyTimes(project, nodes), [project, nodes])
  return (
    <DrawingKeyButtons
      name="Node"
      testId="node-position"
      entries={entries}
      isKeyedAt={(time) => hasNodeKeysAt(project, nodes, time)}
      edit={(time, isKeyed) => (current) => setNodeKeys(current, nodes, time, isKeyed)}
    />
  )
}

const PART_NAMES: Record<SetPart, string> = { rotation: 'Rotation', scale: 'Scale', position: 'Position' }

function SetKeyButtons({ set, part, testId }: { set: SetRef; part: SetPart; testId: string }): ReactElement {
  const project = useEditorState((state) => state.project)
  const entries = useMemo(() => setKeyTimes(project, [set], part), [project, set, part])
  return (
    <DrawingKeyButtons
      name={PART_NAMES[part]}
      testId={testId}
      entries={entries}
      isKeyedAt={(time) => hasSetKeysAt(project, [set], part, time)}
      edit={(time, isKeyed) => (current) => setNodeSetKeys(current, set, part, time, isKeyed)}
    />
  )
}

// The first key gives each chosen shape its own set.
function ShapeKeyButtons({ shapes, part, testId }: { shapes: readonly ShapeRef[]; part: SetPart; testId: string }): ReactElement {
  const project = useEditorState((state) => state.project)
  const entries = useMemo(() => shapeKeyTimes(project, shapes, part), [project, shapes, part])
  return (
    <DrawingKeyButtons
      name={PART_NAMES[part]}
      testId={testId}
      entries={entries}
      isKeyedAt={(time) => hasShapeKeysAt(project, shapes, part, time)}
      edit={(time, isKeyed) => (current) => setShapesKeys(current, shapes, part, time, isKeyed, () => crypto.randomUUID())}
    />
  )
}

// What the chosen shapes' own sets add at the playhead; shapes without one show the rest.
function ShapeTransformFields(): ReactElement {
  const { transport } = useSession()
  const project = useEditorState((state) => state.project)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const shownAt = (part: keyof ShapePose, time: number): number | undefined => sharedValue(selectedShapes.map((ref) => shapePoseAt(project, ref, time)[part]))
  const x = usePosition((position) => shownAt('x', position.time))
  const y = usePosition((position) => shownAt('y', position.time))
  const scale = usePosition((position) => shownAt('scale', position.time))
  const rotation = usePosition((position) => shownAt('rotation', position.time))
  const noun = selectedShapes.length === 1 ? 'Shape' : 'Shapes'
  const posed = (values: SetValues): Edit => (current) => setShapesPose(current, selectedShapes, values, transport.position().time, () => crypto.randomUUID())
  return (
    <>
      <div className="field-pair">
        <EditField label="X" testId="shape-x" command={`Move ${noun}`} value={x} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={(value) => posed({ x: value })} />
        <EditField label="Y" testId="shape-y" command={`Move ${noun}`} value={y} min={-MAX_POSITION} max={MAX_POSITION} decimals={1} edit={(value) => posed({ y: value })} />
        <ShapeKeyButtons shapes={selectedShapes} part="position" testId="shape-position" />
      </div>
      <EditField
        label="Scale (%)"
        testId="shape-scale"
        command={`Scale ${noun}`}
        value={scale === undefined ? undefined : scale * PERCENT}
        min={MIN_SET_SCALE_PERCENT}
        max={MAX_SCALE_PERCENT}
        decimals={1}
        keyframes={<ShapeKeyButtons shapes={selectedShapes} part="scale" testId="shape-scale" />}
        edit={(value) => posed({ scale: value / PERCENT })}
      />
      <EditField
        label="Rotation (°)"
        testId="shape-rotation"
        command={`Rotate ${noun}`}
        value={rotation}
        min={-MAX_ROTATION}
        max={MAX_ROTATION}
        decimals={1}
        keyframes={<ShapeKeyButtons shapes={selectedShapes} part="rotation" testId="shape-rotation" />}
        edit={(value) => posed({ rotation: value })}
      />
    </>
  )
}

type ClipMode = 'play' | 'hold'

const CLIP_MODES: readonly SegmentChoice<ClipMode>[] = [
  { value: 'play', label: 'Play' },
  { value: 'hold', label: 'Hold frame' },
]

const FRAME_ROW_HEIGHT = 56
const FRAME_ROW_GAP = 4
const FRAME_ROW_STEP = FRAME_ROW_HEIGHT + FRAME_ROW_GAP
const FRAMES_PER_ROW = 3
const FRAME_PICKER_HEIGHT = 244
const FRAME_ROWS_IN_VIEW = Math.ceil(FRAME_PICKER_HEIGHT / FRAME_ROW_STEP) + 1

function FrameCell({ path, document, frame, frameTicks, isChosen, onPick }: { path: string; document: Project; frame: number; frameTicks: number; isChosen: boolean; onPick(frame: number): void }): ReactElement {
  const { thumbnails } = useSession()
  const picture = thumbnails.animationFrame(path, document, frame * frameTicks)
  const name = `Frame ${frame}`
  return (
    <button type="button" className="frame-cell focusable" data-testid={`held-frame-${frame}`} data-tooltip={name} aria-label={name} aria-pressed={isChosen} onClick={() => onPick(frame)}>
      {picture !== undefined && <Poster picture={picture} />}
    </button>
  )
}

// Only the rows in view exist, so a long animation asks for no more thumbnails than a short one.
function HeldFramePicker({ clips }: { clips: readonly AnimationClip[] }): ReactElement | null {
  const { store } = useSession()
  const mediaStates = useEditorState((state) => state.mediaStates)
  const documents = useEditorState((state) => state.documents)
  const listRef = useRef<HTMLDivElement>(null)
  const [firstRow, setFirstRow] = useState(0)
  useThumbnailUpdates()

  const heldTime = sharedValue(clips.map((clip) => clip.heldTime))
  const mediaId = sharedValue(clips.map((clip) => clip.mediaId))
  const state = mediaId === undefined ? undefined : mediaStates[mediaId]
  const path = state !== undefined && 'info' in state && state.info.kind === 'animation' ? state.info.path : undefined
  const document = path === undefined ? undefined : documents[path]
  const frameTicks = document === undefined ? 1 : frameDuration(document.canvas.frameRate)
  const chosenFrame = heldTime === undefined ? undefined : Math.floor(heldTime / frameTicks)

  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null || chosenFrame === undefined) return
    const top = Math.floor(chosenFrame / FRAMES_PER_ROW) * FRAME_ROW_STEP
    const isInView = top >= list.scrollTop && top + FRAME_ROW_HEIGHT <= list.scrollTop + list.clientHeight
    if (!isInView) list.scrollTop = top
  }, [chosenFrame, mediaId])

  if (!clips.every(isHeld) || path === undefined || document === undefined) return null
  const frameCount = Math.ceil(projectDuration(document) / frameTicks)
  if (frameCount === 0) return null
  const ids = clips.map((clip) => clip.id)

  function pick(frame: number): void {
    store.apply('Pick Frame', (project) => setHeldFrame(project, ids, frame * frameTicks))
  }

  const rowCount = Math.ceil(frameCount / FRAMES_PER_ROW)
  const shownFrames: number[] = []
  const endFrame = Math.min(frameCount, (firstRow + FRAME_ROWS_IN_VIEW) * FRAMES_PER_ROW)
  for (let frame = firstRow * FRAMES_PER_ROW; frame < endFrame; frame++) shownFrames.push(frame)
  return (
    <div
      ref={listRef}
      className="frame-picker"
      role="group"
      aria-label="Held frame"
      data-testid="held-frames"
      style={{ maxHeight: FRAME_PICKER_HEIGHT }}
      onScroll={(event) => setFirstRow(Math.floor(event.currentTarget.scrollTop / FRAME_ROW_STEP))}
    >
      <div
        className="frame-grid"
        style={{ height: rowCount * FRAME_ROW_STEP - FRAME_ROW_GAP, paddingTop: firstRow * FRAME_ROW_STEP, gridAutoRows: FRAME_ROW_HEIGHT, rowGap: FRAME_ROW_GAP, gridTemplateColumns: `repeat(${FRAMES_PER_ROW}, 1fr)` }}
      >
        {shownFrames.map((frame) => (
          <FrameCell key={frame} path={path} document={document} frame={frame} frameTicks={frameTicks} isChosen={frame === chosenFrame} onPick={pick} />
        ))}
      </div>
    </div>
  )
}

function ClipProperties({ clips }: { clips: readonly Clip[] }): ReactElement {
  const mediaStates = useEditorState((state) => state.mediaStates)
  const documents = useEditorState((state) => state.documents)
  const canvas = useEditorState((state) => state.project.canvas)
  const isAnimated = clips.some((clip) => clip.keyframes !== undefined)
  const time = usePosition((position) => (isAnimated ? position.time : 0))
  const [keepsAspect, setKeepsAspect] = useState(true)
  const ids = useMemo(() => clips.map((clip) => clip.id), [clips])
  const frameTicks = frameDuration(canvas.frameRate)
  const isInAnimation = useEditorState((state) => state.openChain.length > 0)
  const timing = isInAnimation ? { unit: 'frames', ticks: frameTicks, decimals: 0 } : { unit: 's', ticks: TICKS_PER_SECOND, decimals: SECONDS_DECIMALS }
  const { store, actions, transport } = useSession()
  const visual = clips.filter(isVisual)
  const croppable = clips.filter(isCroppable)
  const worded = clips.filter(hasWords)
  const callouts = clips.filter(isCallout)
  const arrows = clips.filter(isArrow)
  const groups = clips.filter((clip) => clip.type === 'group')
  const animations = clips.filter((clip) => clip.type === 'animation')
  const sourced = clips.filter(playsSource)
  const loopable = clips.filter((clip) => isLoopable(clip, mediaStates))
  const isLooping = loopable.length > 0 && loopable.every((clip) => clip.loop === true)
  const sounding = clips.filter((clip) => makesSound(clip, mediaStates, documents))
  const soundingIds = sounding.map((clip) => clip.id)
  const stretched = sourced.filter((clip) => soundingIds.includes(clip.id))
  const fast = stretched.filter((clip) => clip.speedPercent > FAST_SOUND_ABOVE_PERCENT)
  const hasSize = visual.some((clip) => !isContainer(clip))
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

  function wholeFrames(ticks: number): number {
    return Math.round(ticks / frameTicks) * frameTicks
  }

  function inTimingUnits(ticks: number | undefined): number | undefined {
    return ticks === undefined ? undefined : ticks / timing.ticks
  }

  function setSide(side: 'width' | 'height'): (value: number) => Edit {
    const axis = side === 'width' ? 'scaleX' : 'scaleY'
    const otherAxis = side === 'width' ? 'scaleY' : 'scaleX'
    return (value) => (project) => {
      let edited = project
      for (const clip of visual) {
        const size = shownSize(clip, mediaStates, time)
        const before = propertyAt(clip, axis, time)
        const other = propertyAt(clip, otherAxis, time)
        if (size === undefined || size[side] <= 0) continue
        if (before === undefined || other === undefined) continue
        const scale = value / size[side]
        const changes: PropertyValues = { [axis]: scale }
        if (keepsAspect && before > 0) changes[otherAxis] = (other * scale) / before
        edited = setProperties(edited, [clip.id], changes, time)
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
        if (size === undefined || scale === undefined) return undefined
        return size[side] * scale
      }),
    )
  }

  function setCrop(side: keyof Crop, property: AnimatableProperty): (value: number) => Edit {
    return (value) => (project) => {
      let edited = project
      for (const clip of croppable) {
        const natural = pictureSize(clip, mediaStates)
        if (natural === undefined) continue
        const { crop, transform } = placementAt(clip, time)
        const cropped = cropFromValue(natural, crop, transform, side, value)
        const changes = { [property]: cropped.crop[side], x: cropped.transform.x, y: cropped.transform.y }
        edited = setProperties(edited, [clip.id], changes, time)
      }
      return edited
    }
  }

  function setStart(value: number): Edit {
    const start = wholeFrames(value * timing.ticks)
    return (project) => {
      let edited = project
      for (const clip of clips) {
        const newTrack = { id: freeTrackId(edited, `${clip.id}-track`), name: nextTrackName(edited) }
        const move = { clipIds: [clip.id], deltaTime: start - clip.start, trackShift: 0, isRipple: false, newTrack }
        edited = moveClips(edited, move)
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
        decimals={SECONDS_DECIMALS}
        presets={FADE_SECONDS}
        edit={(next) => (project) => setFade(project, ids, fade, wholeFrames(next * TICKS_PER_SECOND))}
      />
    )
  }

  function setScale(percent: number): Edit {
    const scale = percent / PERCENT
    return (project) => setProperties(project, ids, { scaleX: scale, scaleY: scale }, time)
  }

  function keepPitch(isOn: boolean): void {
    const command = isOn ? 'Keep Pitch' : 'Let Pitch Follow Speed'
    store.apply(command, (project) => setSoundSwitches(project, ids, { changesPitch: !isOn }))
  }

  function playFastSound(isOn: boolean): void {
    const command = isOn ? 'Play Fast Sound' : 'Mute Fast Sound'
    store.apply(command, (project) => setSoundSwitches(project, ids, { hasFastSound: isOn }))
  }

  function switchLoop(isOn: boolean): void {
    const command = isOn ? 'Loop Clip' : 'Stop Looping'
    store.apply(command, (project) => setLoop(project, ids, isOn, mediaStates, documents))
  }

  function chooseMode(mode: ClipMode): void {
    if (mode === 'hold') store.apply('Hold Frame', (project) => holdShownFrames(project, ids, transport.position().time, mediaStates, documents))
    else store.apply('Play Clip', (project) => playHeldClips(project, ids, mediaStates, documents))
  }

  function pixelate(isOn: boolean): void {
    styleShapes(isOn ? 'Pixelate' : 'Blur', { isPixelated: isOn })
  }

  function spotlight(isOn: boolean): void {
    styleShapes(isOn ? 'Make Spotlight' : 'Make Highlight', { isSpotlight: isOn })
  }

  const scaleX = shared('scaleX')
  const isUniform = scaleX !== undefined && scaleX === shared('scaleY')
  const uniformScale = isUniform ? scaleX * PERCENT : undefined
  const frameInTimingUnits = frameTicks / timing.ticks
  const maxInTimingUnits = (MAX_SECONDS * TICKS_PER_SECOND) / timing.ticks
  const aspectLock = <IconButton icon="link" label="Keep the aspect ratio" testId="aspect-lock" isPressed={keepsAspect} onClick={() => setKeepsAspect(!keepsAspect)} />
  return (
    <>
      {visual.length > 0 && (
        <Group title="Transform" icon="move" isOpenAtStart actions={aspectLock}>
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
            edit={setScale}
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
        {animations.length === clips.length && (
          <>
            <ChoiceField label="Mode" testId="clip-mode" choices={CLIP_MODES} value={sharedValue(animations.map((clip) => (isHeld(clip) ? 'hold' : 'play')))} onChoose={chooseMode} />
            <HeldFramePicker clips={animations} />
          </>
        )}
        <EditField
          label={`Start (${timing.unit})`}
          testId="clip-start"
          command="Move Clip"
          value={inTimingUnits(sharedValue(clips.map((clip) => clip.start)))}
          min={0}
          max={maxInTimingUnits}
          step={frameInTimingUnits}
          decimals={timing.decimals}
          edit={setStart}
        />
        <EditField
          label={`Duration (${timing.unit})`}
          testId="clip-duration"
          command="Trim Clip"
          value={inTimingUnits(sharedValue(clips.map((clip) => clip.duration)))}
          min={frameInTimingUnits}
          max={maxInTimingUnits}
          step={frameInTimingUnits}
          decimals={timing.decimals}
          edit={(next) => (project) => setDuration(project, ids, wholeFrames(next * timing.ticks), frameTicks, mediaStates, documents)}
        />
        {sourced.length > 0 && (
          <>
            <EditField
              label={`Source offset (${timing.unit})`}
              testId="clip-source-start"
              command="Change Source Offset"
              value={inTimingUnits(sharedValue(sourced.map((clip) => clip.sourceStart)))}
              min={0}
              max={maxInTimingUnits}
              step={frameInTimingUnits}
              decimals={timing.decimals}
              edit={(next) => (project) => setSourceStart(project, ids, next * timing.ticks, mediaStates, documents)}
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
            onSwitch={keepPitch}
          />
        )}
        {fast.length > 0 && (
          <SwitchField
            label={`Sound above ${FAST_SOUND_ABOVE_PERCENT}%`}
            testId="clip-fast-sound"
            isOn={fast.every((clip) => clip.hasFastSound === true)}
            onSwitch={playFastSound}
          />
        )}
        {loopable.length > 0 && (
          <label className="check-field">
            <input
              type="checkbox"
              data-testid="clip-loop"
              checked={isLooping}
              onChange={(event) => switchLoop(event.target.checked)}
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
      {animations.length > 0 && (
        <Group title="Animation" icon="animation">
          <button type="button" className="button" data-testid="animation-open" disabled={clips.length !== 1} onClick={actions.openGroup}>
            Open animation
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
          <SwitchField label="Pixelate" testId="blur-pixelate" isOn={isPixelated} onSwitch={pixelate} />
        </Group>
      )}
      {highlights.length > 0 && (
        <Group title="Highlight" icon="marker">
          <ShapeFields clips={highlights} />
          <ColorField
            label="Colour"
            testId="highlight-color"
            command="Change Highlight Colour"
            value={sharedValue(highlights.map((clip) => clip.color))}
            edit={(color) => (project) => setShapeStyle(project, ids, { color })}
          />
          <SwitchField label="Spotlight" testId="highlight-spotlight" isOn={isSpotlight} onSwitch={spotlight} />
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
            max={MAX_VOLUME_PERCENT}
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
  const isAnimationOpen = useEditorState(isAnimationRootOpen)
  const isInAnimation = useEditorState((state) => state.openChain.length > 0)
  const hasShapes = useEditorState((state) => state.selectedShapes.length > 0)
  const tool = useEditorState((state) => state.tool)
  const clips = useMemo(() => selectedClips(project, selection), [project, selection])
  if (selectedZoom !== undefined) return <ZoomProperties index={selectedZoom} />
  if (clips.length > 0) return <ClipProperties clips={clips} />
  let toolGroup: ReactElement | undefined
  if (isInAnimation && tool === 'node' && hasShapes) {
    toolGroup = (
      <Group title="Node" icon="node" isOpenAtStart>
        <NodeFields />
      </Group>
    )
  } else if (isInAnimation && tool === 'move' && hasShapes) {
    toolGroup = (
      <Group title="Transform" icon="move" isOpenAtStart>
        <ShapeTransformFields />
      </Group>
    )
  } else if (isInAnimation && tool === 'pen') {
    toolGroup = (
      <Group title="Pen" icon="pen" isOpenAtStart>
        <PenFields />
      </Group>
    )
  }
  const colour = (
    <>
      {toolGroup}
      <Group title="Colour" icon="droplet" isOpenAtStart>
        <ColorFields />
      </Group>
      <Group title="Stroke" icon="line" isOpenAtStart>
        <StrokeFields />
      </Group>
    </>
  )
  if (hasShapes) return colour
  if (isAnimationOpen) {
    return (
      <>
        <CanvasSettings title="Animation" frameRates={ANIMATION_FRAME_RATES} />
        {colour}
      </>
    )
  }
  if (isInAnimation) {
    return (
      <>
        <OpenGroupNote />
        {colour}
      </>
    )
  }
  return isGroupOpen ? <OpenGroupNote /> : <CanvasSettings title="Project" frameRates={PROJECT_FRAME_RATES} />
}
