import {AlertTriangle} from 'lucide-react'

const DEFAULT_WRAPPER_CLASS =
  'bg-card text-secondary-foreground mx-auto min-h-0 w-full flex-1 space-y-2 overflow-y-auto break-words text-sm leading-7'

interface ConflictContentViewProps {
  className?: string
  content: string
}

export function ConflictContentView({className, content}: ConflictContentViewProps) {
  return (
    <div className={className ?? DEFAULT_WRAPPER_CLASS}>
      <div className="bg-[#4f3422] text-[#ffc53d] mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
        <AlertTriangle className="size-3.5 shrink-0" />
        <span>Unresolved conflict markers — showing raw content with side highlighting.</span>
      </div>
      <ConflictRawView content={content} />
    </div>
  )
}

function ConflictRawView({content}: {content: string}) {
  const lines = content.split('\n')
  let region: 'none' | 'ours' | 'theirs' = 'none'

  return (
    <pre className="bg-card overflow-x-auto rounded-md py-2 font-mono text-xs leading-6">
      {lines.map((line, i) => {
        let cls = 'block px-3 whitespace-pre-wrap break-all'
        if (line.startsWith('<<<<<<<')) {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'ours'
        } else if (line.startsWith('=======') && region !== 'none') {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'theirs'
        } else if (line.startsWith('>>>>>>>')) {
          cls += ' bg-[#4f3422] text-[#ffc53d] font-semibold'
          region = 'none'
        }

        return (
          <span className={cls} key={i}>
            {line || '\u00A0'}
          </span>
        )
      })}
    </pre>
  )
}
