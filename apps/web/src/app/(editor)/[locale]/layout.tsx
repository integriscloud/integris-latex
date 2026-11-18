import { jetBrainsMono, plusJakartaSans } from '../../../fonts/fonts';
import {
  type LocaleLayoutProps,
  LocaleRoot,
  localeMetadata,
  localeStaticParams,
} from '../../../components/root/LocaleRoot';
import '../../globals.css';
import styles from './editor-root.module.css';

export const generateStaticParams = localeStaticParams;
export const generateMetadata = localeMetadata;

/**
 * Root layout of the editor: only Plus Jakarta Sans and JetBrains Mono are loaded
 * (docs/design/README.md); titles fall back to the UI face.
 */
export default function EditorRootLayout({ children, params }: LocaleLayoutProps) {
  return (
    <LocaleRoot
      params={params}
      fontClasses={`${plusJakartaSans.variable} ${jetBrainsMono.variable}`}
      bodyClassName={styles.body}
    >
      {children}
    </LocaleRoot>
  );
}
