import { useMemo } from 'react';
import { SAMPLE_EDITION, SAMPLE_TOKENS, SAMPLE_TOKENS_MULTIFILE, SAMPLE_TOKENS_NO_SERIES } from '@/lib/naming-samples';
import { renderTemplate, renderFilename, templateHasToken, composeEditionSuffixLeaf, sanitizeEditionDiscriminator } from '@core/utils/index.js';
import type { NamingOptions } from '@core/utils/naming.js';

/**
 * The sample previews rendered under the two naming format fields: one per fixture, plus the
 * two edition variants the folder and file paths handle differently.
 *
 * Every memo keys on the `namingOptions` REFERENCE rather than its field values, so a caller
 * passing a fresh object literal each render recomputes all seven — pass a memoized object.
 */
export function useNamingPreviews(folderFormat: string | undefined, fileFormat: string | undefined, namingOptions: NamingOptions) {
  const folderPreview = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS, namingOptions) : '', [folderFormat, namingOptions]);
  const folderPreviewNoSeries = useMemo(() => folderFormat ? renderTemplate(folderFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [folderFormat, namingOptions]);
  // Match buildTargetPath: explicit {edition} renders in place; otherwise suffix the folder leaf.
  const folderPreviewMultiEdition = useMemo(() => {
    if (!folderFormat) return '';
    if (templateHasToken(folderFormat, 'edition')) {
      return renderTemplate(folderFormat, { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION }, namingOptions);
    }
    const discriminator = sanitizeEditionDiscriminator(SAMPLE_EDITION);
    if (!discriminator) return folderPreview;
    const segments = folderPreview.split('/');
    segments[segments.length - 1] = composeEditionSuffixLeaf(segments[segments.length - 1] ?? '', discriminator);
    return segments.join('/');
  }, [folderFormat, namingOptions, folderPreview]);
  const filePreview = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS, namingOptions) : '', [fileFormat, namingOptions]);
  const filePreviewNoSeries = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS_NO_SERIES, namingOptions) : '', [fileFormat, namingOptions]);
  const filePreviewMultiFile = useMemo(() => fileFormat ? renderFilename(fileFormat, SAMPLE_TOKENS_MULTIFILE, namingOptions) : '', [fileFormat, namingOptions]);
  // Files never auto-append edition, so render it only when the template contains the token.
  const filePreviewEdition = useMemo((): { hasToken: boolean; rendered: string } => {
    const hasToken = !!fileFormat && templateHasToken(fileFormat, 'edition');
    return {
      hasToken,
      rendered: hasToken ? renderFilename(fileFormat!, { ...SAMPLE_TOKENS, edition: SAMPLE_EDITION }, namingOptions) : '',
    };
  }, [fileFormat, namingOptions]);

  return { folderPreview, folderPreviewNoSeries, folderPreviewMultiEdition, filePreview, filePreviewNoSeries, filePreviewMultiFile, filePreviewEdition };
}
