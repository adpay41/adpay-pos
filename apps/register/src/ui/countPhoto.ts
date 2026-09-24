/**
 * Photo of the drawer count sheet (build plan P15, Bible 1.2). On the register it opens the
 * camera; in the browser build, a file picker. Shrunk to ~1024px JPEG on the device before upload,
 * so it is tens of KB, not megabytes. Null when the cashier cancels.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

const EDGE = 1024;

export async function takeCountPhoto(): Promise<Blob | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  let result: ImagePicker.ImagePickerResult;
  if (Platform.OS !== 'web') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('camera access is off');
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const ctx = ImageManipulator.manipulate(asset.uri);
  if ((asset.width ?? EDGE + 1) > EDGE || (asset.height ?? EDGE + 1) > EDGE) ctx.resize(asset.width >= asset.height ? { width: EDGE } : { height: EDGE });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
  return (await fetch(saved.uri)).blob();
}
