import * as React from 'react'

import { cn } from '@/shared/lib/utils'

const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.ComponentPropsWithoutRef<'select'>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
NativeSelect.displayName = 'NativeSelect'

const NativeSelectOption = React.forwardRef<
  HTMLOptionElement,
  React.ComponentPropsWithoutRef<'option'>
>((props, ref) => <option ref={ref} {...props} />)
NativeSelectOption.displayName = 'NativeSelectOption'

const NativeSelectOptGroup = React.forwardRef<
  HTMLOptGroupElement,
  React.ComponentPropsWithoutRef<'optgroup'>
>((props, ref) => <optgroup ref={ref} {...props} />)
NativeSelectOptGroup.displayName = 'NativeSelectOptGroup'

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup }
