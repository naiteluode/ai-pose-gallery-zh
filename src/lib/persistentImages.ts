import type { RecipeState } from '@/types/gallery'
import { referenceImageUrl } from './recipeImages'

export async function durableImage(url: string): Promise<string> {
  if (url.startsWith('data:image/')) return url
  const response = await fetch(referenceImageUrl(url))
  if (!response.ok) throw new Error('图片下载失败')
  let blob = await response.blob()
  if (!blob.type.startsWith('image/')) {
    // 部分对象存储（如硅基流动 S3 temporary 桶）返回 application/octet-stream，
    // 按魔数 / URL 扩展名嗅探真实类型后放行，避免把有效的图片误判为「引用不是图片」。
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
    const hex4 = Array.from(head.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || ''
    const mime =
      hex4.startsWith('89504e47') ? 'image/png'
      : hex4.startsWith('ffd8ff') ? 'image/jpeg'
      : hex4.startsWith('52494646') && ext === 'webp' ? 'image/webp'
      : ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : ''
    if (!mime) throw new Error('引用不是图片')
    blob = new Blob([blob], { type: mime })
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}
export async function durableRecipe(recipe: RecipeState) {
  const next = structuredClone(recipe)
  for (const item of [next.portrait, next.costume, next.pose]) {
    if (item?.source === 'upload') {
      item.原图 = await durableImage(item.原图)
      item.缩略图 = item.原图
      if ('预览图' in item) item.预览图 = item.原图
    }
  }
  for (const image of [...(next.extraImages || []), ...Object.values(next.workflowImages || {})]) image.url = await durableImage(image.url)
  return next
}
