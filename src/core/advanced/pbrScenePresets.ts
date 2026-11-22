import { uiText } from '../../i18n/messages'
import type { PreviewScene } from '../sceneWorkbench'
import type { PbrPreviewProfile } from './pbrPreview'

export interface PbrScenePreset { id: string; label: string; profile: PbrPreviewProfile; lighting: PreviewScene['lighting'] }
export const PBR_SCENE_PRESETS: readonly PbrScenePreset[] = [
  { id: 'lab-day', label: uiText("core.advanced.pbrScenePresets.labpbrSun"), profile: 'labPBR', lighting: { sunDirection: [-0.4, 1, 0.6], sunIntensity: 3, ambientIntensity: 0.35, environmentIntensity: 0.8, exposure: 1, shadows: true } },
  { id: 'old-day', label: uiText("core.advanced.pbrScenePresets.oldpbrDaylight"), profile: 'oldPBR', lighting: { sunDirection: [-0.4, 1, 0.6], sunIntensity: 3, ambientIntensity: 0.35, environmentIntensity: 0.8, exposure: 1, shadows: true } },
  { id: 'lab-studio', label: uiText("core.advanced.pbrScenePresets.labpbrSoftLight"), profile: 'labPBR', lighting: { sunDirection: [0.8, 0.7, 0.3], sunIntensity: 1.8, ambientIntensity: 0.7, environmentIntensity: 1.3, exposure: 1.1, shadows: true } },
  { id: 'old-studio', label: uiText("core.advanced.pbrScenePresets.oldpbrSoftLight"), profile: 'oldPBR', lighting: { sunDirection: [0.8, 0.7, 0.3], sunIntensity: 1.8, ambientIntensity: 0.7, environmentIntensity: 1.3, exposure: 1.1, shadows: true } }
]
