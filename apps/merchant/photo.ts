/**
 * Product photo capture for the merchant app: take or pick a photo, square-crop and shrink it on the
 * phone (512px JPEG, tens of KB), upload it, get back a media id to put on the item. Resizing on the
 * phone keeps uploads fast on store Wi-Fi and well under the API's 1 MB cap.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { upload } from './api';

const EDGE = 512;

export type PhotoSource = 'camera' | 'library';

/** Returns the uploaded media, or null if the user cancelled. Throws with a readable message otherwise. */
export async function captureAndUpload(token: string, source: PhotoSource): Promise<{ media_id: string; url: string } | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera' && Platform.OS !== 'web') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Camera access is off. Turn it on in Settings to snap item photos.');
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  const ctx = ImageManipulator.manipulate(asset.uri);
  // Shrink only; never upscale a small photo.
  if ((asset.width ?? EDGE + 1) > EDGE || (asset.height ?? EDGE + 1) > EDGE) {
    ctx.resize(asset.width >= asset.height ? { width: EDGE } : { height: EDGE });
  }
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ compress: 0.72, format: SaveFormat.JPEG });
  const blob = await (await fetch(saved.uri)).blob();
  return upload<{ media_id: string; url: string }>('/merchant/media', token, blob, 'image/jpeg');
}
