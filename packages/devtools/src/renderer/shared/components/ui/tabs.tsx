import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/shared/lib/utils"

type TabsVariant = "underline" | "segment"
const TabsVariantContext = React.createContext<TabsVariant>("underline")

const LIST: Record<TabsVariant, string> = {
  underline: "inline-flex items-center gap-4 border-b border-border",
  segment: "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-foreground",
}
const TRIGGER: Record<TabsVariant, string> = {
  underline: "relative -mb-px inline-flex h-8 appearance-none items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent bg-transparent px-1 text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground",
  segment: "relative inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow data-[state=active]:after:absolute data-[state=active]:after:inset-x-3 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-ring data-[state=active]:after:content-['']",
}

function Tabs({
  className,
  variant = "segment",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.Root className={className} {...props} />
    </TabsVariantContext.Provider>
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const variant = React.useContext(TabsVariantContext)
  return <TabsPrimitive.List className={cn(LIST[variant], className)} {...props} />
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext)
  return <TabsPrimitive.Trigger className={cn(TRIGGER[variant], className)} {...props} />
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
