import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Download from 'yet-another-react-lightbox/plugins/download';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import 'yet-another-react-lightbox/plugins/captions.css';
export default function MediaLightbox({ items, index, onClose, onNavigate }) {
    if (index === null || items.length === 0)
        return null;
    return (<Lightbox open={true} close={onClose} index={index} on={{ view: ({ index: i }) => onNavigate(i) }} slides={items.map(m => ({
            src: m.url,
            alt: m.alt ?? '',
            title: m.senderName,
            description: m.timestamp,
            // Never empty: the library opens the image in a new tab instead of saving it on an empty name.
            download: { url: m.url, filename: m.filename || `image-${m.id}.jpg` },
        }))} plugins={[Zoom, Download, Counter, Captions]} zoom={{
            maxZoomPixelRatio: 3,
            wheelZoomDistanceFactor: 100,
            pinchZoomDistanceFactor: 100,
            scrollToZoom: true,
        }} carousel={{ finite: true, preload: 2 }} controller={{ closeOnBackdropClick: true }}/>);
}
