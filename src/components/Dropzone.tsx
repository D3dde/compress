import { useCallback, useRef, useState } from 'react'
import { isProbablyVideo } from '../lib/source'

interface DropzoneProps {
  onFile: (file: File) => void
  compact?: boolean
}

export function Dropzone({ onFile, compact = false }: DropzoneProps) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setOver(false)
      const file = event.dataTransfer.files?.[0]
      if (file && isProbablyVideo(file)) onFile(file)
    },
    [onFile],
  )

  return (
    <div
      className={`dropzone${over ? ' dropzone--over' : ''}${compact ? ' dropzone--compact' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file && isProbablyVideo(file)) onFile(file)
          event.target.value = ''
        }}
      />
      {compact ? (
        <p className="dropzone__title">replace</p>
      ) : (
        <>
          <p className="dropzone__title">drop a video here</p>
          <p className="dropzone__hint">or click to choose one — it never leaves this tab</p>
        </>
      )}
    </div>
  )
}