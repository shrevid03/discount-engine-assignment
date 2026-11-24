/**
 * FileUploader.jsx
 *
 * A click-to-upload area for one file. Reads the file as text (CSV) or as an
 * ArrayBuffer (PDF) based on its extension, then calls onLoad(contents, file).
 */

import { useRef } from 'react'

export default function FileUploader({ label, description, accept, onLoad, hasData, fileName, busy }) {
  const inputRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    const reader = new FileReader()
    reader.onload = (evt) => onLoad(evt.target.result, file, isPdf ? 'pdf' : 'csv')
    if (isPdf) reader.readAsArrayBuffer(file)
    else reader.readAsText(file)
    // Reset input so the same file can be re-uploaded
    e.target.value = ''
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Upload ${label}`}
      style={{
        border: `2px dashed ${hasData ? '#1e5c2c' : '#CECECE'}`,
        borderRadius: 6,
        padding: '1rem 1.2rem',
        background: hasData ? '#f0faf2' : '#fafafa',
        cursor: busy ? 'progress' : 'pointer',
        transition: 'border-color 0.15s',
      }}
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span style={{ fontSize: 20 }}>{busy ? '⏳' : hasData ? '✅' : '📄'}</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#131A48' }}>{label}</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            {busy ? 'Reading file…' : hasData ? fileName : description}
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: hasData ? '#1e5c2c' : '#FF5800',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {hasData ? 'Change' : 'Upload'}
          </span>
        </div>
      </div>
    </div>
  )
}
