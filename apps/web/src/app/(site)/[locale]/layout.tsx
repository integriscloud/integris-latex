import { jetBrainsMono, plusJakartaSans } from '../../../fonts/fonts';
import { sourceSerif4 } from '../../../fonts/serif';
import {
  type LocaleLayoutProps,
  LocaleRoot,
  localeMetadata,
  localeStaticParams,
} from '../../../components/root/LocaleRoot';
import '../../globals.css';

export const generateStaticParams = localeStaticParams;
export const generateMetadata = localeMetadata;

/** Root layout of the site and the app pages: UI, document and code faces. */
export default function SiteLayout({ children, params }: LocaleLayoutProps) {
  return (
    <LocaleRoot
      params={params}
      fontClasses={`${plusJakartaSans.variable} ${sourceSerif4.variable} ${jetBrainsMono.variable}`}
    >
      {children}
    </LocaleRoot>
  );
}
