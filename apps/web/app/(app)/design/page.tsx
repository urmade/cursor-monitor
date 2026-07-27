import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Kbd,
  Panel,
  PanelBody,
  PanelHeader,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@nexus/ui';

export default function DesignPage() {
  return (
    <div className="space-y-8 p-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-medium text-fg">Design system</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Nexus UI tokens and primitives — Cursor-app density and contrast.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Semantic colors</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: 'canvas', className: 'bg-canvas' },
            { label: 'surface', className: 'bg-surface' },
            { label: 'border', className: 'bg-border' },
            { label: 'fg', className: 'bg-fg' },
            { label: 'accent', className: 'bg-accent' },
            { label: 'success', className: 'bg-success-bg' },
            { label: 'warning', className: 'bg-warning-bg' },
            { label: 'danger', className: 'bg-danger-bg' },
          ].map((swatch) => (
            <div
              key={swatch.label}
              className="rounded-md border border-border p-2 text-xs"
            >
              <div
                className={`h-8 rounded-sm border border-border ${swatch.className}`}
              />
              <div className="mt-1 font-mono text-fg-muted">{swatch.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Buttons</h2>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Badges</h2>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">neutral</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
          <Badge tone="forward">forward</Badge>
          <Badge tone="backward">backward</Badge>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Form</h2>
        <Panel>
          <PanelBody className="grid gap-3 max-w-md">
            <Field label="Input" hint="13px default UI size">
              <Input placeholder="Placeholder" />
            </Field>
            <Field label="Textarea">
              <Textarea rows={2} />
            </Field>
          </PanelBody>
        </Panel>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Tabs</h2>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">Tab A</TabsTrigger>
            <TabsTrigger value="b">Tab B</TabsTrigger>
          </TabsList>
          <TabsContent value="a">
            <p className="text-sm text-fg-muted">Tab A content</p>
          </TabsContent>
          <TabsContent value="b">
            <p className="text-sm text-fg-muted">Tab B content</p>
          </TabsContent>
        </Tabs>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-fg">Chrome</h2>
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <span>Command palette</span>
        </div>
        <Skeleton className="h-8 w-full" />
        <EmptyState title="Empty state" description="Affirmative idle surfaces." />
      </section>

      <Separator />
      <p className="text-xs text-fg-subtle">
        Toggle theme from the status bar or command palette to preview light mode.
      </p>
    </div>
  );
}
