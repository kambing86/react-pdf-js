import React from 'react';
import { flushSync } from 'react-dom';
import PropTypes from 'prop-types';

require('pdfjs-dist/build/pdf.combined');
require('pdfjs-dist/web/compatibility');

const makeCancelable = (promise) => {
  let hasCanceled = false;

  const wrappedPromise = new Promise((resolve, reject) => {
    promise.then(val => (
      hasCanceled ? reject({ pdf: val, isCanceled: true }) : resolve(val)
    ));
    promise.catch(error => (
      hasCanceled ? reject({ isCanceled: true }) : reject(error)
    ));
  });

  return {
    promise: wrappedPromise,
    cancel() {
      hasCanceled = true;
    },
  };
};

class Pdf extends React.Component {
  static propTypes = {
    content: PropTypes.string,
    documentInitParameters: PropTypes.shape({
      url: PropTypes.string,
    }),
    binaryContent: PropTypes.shape({
      data: PropTypes.any,
    }),
    file: PropTypes.any, // Could be File object or URL string.
    loading: PropTypes.any,
    page: PropTypes.number,
    scale: PropTypes.number,
    rotate: PropTypes.number,
    onContentAvailable: PropTypes.func,
    onBinaryContentAvailable: PropTypes.func,
    binaryToBase64: PropTypes.func,
    onDocumentComplete: PropTypes.func,
    onDocumentError: PropTypes.func,
    onPageComplete: PropTypes.func,
    className: PropTypes.string,
    style: PropTypes.object,
  };

  static defaultProps = {
    page: 1,
    scale: 1.0,
  };

  // Converts an ArrayBuffer directly to base64, without any intermediate 'convert to string then
  // use window.btoa' step and without risking a blow of the stack. According to [Jon Leightons's]
  // tests, this appears to be a faster approach: http://jsperf.com/encoding-xhr-image-data/5
  // Jon Leighton https://gist.github.com/jonleighton/958841
  static defaultBinaryToBase64(arrayBuffer) {
    let base64 = '';
    const encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    const bytes = new Uint8Array(arrayBuffer);
    const byteLength = bytes.byteLength;
    const byteRemainder = byteLength % 3;
    const mainLength = byteLength - byteRemainder;

    let a;
    let b;
    let c;
    let d;
    let chunk;

    // Main loop deals with bytes in chunks of 3
    for (let i = 0; i < mainLength; i += 3) {
      // Combine the three bytes into a single integer
      chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

      // Use bitmasks to extract 6-bit segments from the triplet
      a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
      b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
      c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
      d = chunk & 63; // 63 = 2^6 - 1

      // Convert the raw binary segments to the appropriate ASCII encoding
      base64 = [base64, encodings[a], encodings[b], encodings[c], encodings[d]].join('');
    }

    // Deal with the remaining bytes and padding
    if (byteRemainder === 1) {
      chunk = bytes[mainLength];

      a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

      // Set the 4 least significant bits to zero
      b = (chunk & 3) << 4; // 3   = 2^2 - 1

      base64 = [base64, encodings[a], encodings[b], '=='].join('');
    } else if (byteRemainder === 2) {
      chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

      a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
      b = (chunk & 1008) >> 4; // 1008  = (2^6 - 1) << 4

      // Set the 2 least significant bits to zero
      c = (chunk & 15) << 2; // 15    = 2^4 - 1

      base64 = [base64, encodings[a], encodings[b], encodings[c], '='].join('');
    }

    return base64;
  }

  state = {};

  componentDidMount() {
    this.loadPDFDocument(this.props);
    this.renderPdf();
  }

  componentWillReceiveProps(newProps) {
    const { pdf } = this.state;

    const newDocInit = (newProps.documentInitParameters && newProps.documentInitParameters.url) ?
      newProps.documentInitParameters.url : null;
    const docInit = (this.props.documentInitParameters && this.props.documentInitParameters.url) ?
      this.props.documentInitParameters.url : null;

    // Only reload if the most significant source has changed!
    let newSource = newProps.file;
    let oldSource = newSource ? this.props.file : null;
    newSource = newSource || newProps.binaryContent;
    oldSource = newSource && !oldSource ? this.props.binaryContent : oldSource;
    newSource = newSource || newProps.content;
    oldSource = newSource && !oldSource ? this.props.content : oldSource;
    newSource = newSource || newDocInit;
    oldSource = newSource && !oldSource ? docInit : oldSource;

    if (newSource && newSource !== oldSource &&
      ((newProps.file && newProps.file !== this.props.file) ||
      (newProps.content && newProps.content !== this.props.content) ||
      (newDocInit && JSON.stringify(newDocInit) !== JSON.stringify(docInit)))) {
      this.loadPDFDocument(newProps);
    }

    if (pdf && ((newProps.page && newProps.page !== this.props.page) ||
      (newProps.scale && newProps.scale !== this.props.scale) ||
      (newProps.rotate && newProps.rotate !== this.props.rotate))) {
      this.setState({ page: null });
      pdf.getPage(newProps.page).then(this.onPageComplete);
    }
  }

  componentWillUnmount() {
    const { pdf } = this.state;
    if (pdf) {
      pdf.destroy();
    }
    if (this.documentPromise) {
      this.documentPromise.cancel();
    }
  }

  onGetPdfRaw = (pdfRaw) => {
    const { onContentAvailable, onBinaryContentAvailable, binaryToBase64 } = this.props;
    if (typeof onBinaryContentAvailable === 'function') {
      onBinaryContentAvailable(pdfRaw);
    }
    if (typeof onContentAvailable === 'function') {
      let convertBinaryToBase64 = this.defaultBinaryToBase64;
      if (typeof binaryToBase64 === 'function') {
        convertBinaryToBase64 = binaryToBase64;
      }
      onContentAvailable(convertBinaryToBase64(pdfRaw));
    }
  }

  onDocumentComplete = (pdf) => {
    this.setState({ pdf });
    const { onDocumentComplete, onContentAvailable, onBinaryContentAvailable } = this.props;
    if (typeof onDocumentComplete === 'function') {
      onDocumentComplete(pdf.numPages);
    }
    if (typeof onContentAvailable === 'function' || typeof onBinaryContentAvailable === 'function') {
      pdf.getData().then(this.onGetPdfRaw);
    }
    pdf.getPage(this.props.page).then(this.onPageComplete);
  }

  onDocumentError = (err) => {
    if (err.isCanceled && err.pdf) {
      err.pdf.destroy();
    }
    if (typeof this.props.onDocumentError === 'function') {
      this.props.onDocumentError(err);
    }
  }

  onPageComplete = (page) => {
    flushSync(() => {
      this.setState({ page });
    });
    this.renderPdf();
    const { onPageComplete } = this.props;
    if (typeof onPageComplete === 'function') {
      onPageComplete(page.pageIndex + 1);
    }
  }

  getDocument = (val) => {
    if (this.documentPromise) {
      this.documentPromise.cancel();
    }
    this.documentPromise = makeCancelable(window.PDFJS.getDocument(val).promise);
    this.documentPromise
      .promise
      .then(this.onDocumentComplete)
      .catch(this.onDocumentError);
    return this.documentPromise;
  }


  loadByteArray = (byteArray) => {
    this.getDocument(byteArray);
  }

  loadPDFDocument = (props) => {
    if (props.file) {
      if (typeof props.file === 'string') {
        return this.getDocument(props.file);
      }
      // Is a File object
      const reader = new FileReader();
      reader.onloadend = () =>
        this.loadByteArray(new Uint8Array(reader.result));
      reader.readAsArrayBuffer(props.file);
    } else if (props.binaryContent) {
      this.loadByteArray(props.binaryContent);
    } else if (props.content) {
      const bytes = window.atob(props.content);
      const byteLength = bytes.length;
      const byteArray = new Uint8Array(new ArrayBuffer(byteLength));
      for (let index = 0; index < byteLength; index += 1) {
        byteArray[index] = bytes.charCodeAt(index);
      }
      this.loadByteArray(byteArray);
    } else if (props.documentInitParameters) {
      return this.getDocument(props.documentInitParameters);
    } else {
      throw new Error('react-pdf-js works with a file(URL) or (base64)content. At least one needs to be provided!');
    }
  }

  renderPdf = () => {
    const { page } = this.state;
    if (page) {
      const { canvas } = this;
      const canvasContext = canvas.getContext('2d');
      const dpiScale = window.devicePixelRatio || 1;
      const { scale, rotate } = this.props;
      const adjustedScale = scale * dpiScale;
      const viewport = page.getViewport(adjustedScale, rotate);
      canvas.style.width = `${viewport.width / dpiScale}px`;
      canvas.style.height = `${viewport.height / dpiScale}px`;
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      page.render({ canvasContext, viewport });
    }
  }

  render() {
    const { loading } = this.props;
    const { page } = this.state;
    return page ?
      <canvas
        ref={(c) => { this.canvas = c; }}
        className={this.props.className}
        style={this.props.style}
      /> :
      loading || <div>Loading PDF...</div>;
  }
}

Pdf.displayName = 'react-pdf-js';

export default Pdf;
