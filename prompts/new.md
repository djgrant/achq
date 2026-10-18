You're working on {{thread.id}}: {{thread.title}} ({{thread.url}}).

## Opening post

{{thread.body}}

## Replies

{{#messages}}
### @{{author}} · {{date}}

{{body}}

{{/messages}}
{{^messages}}
(none)

{{/messages}}
{{#omitted}}
(Left out {{omitted}} message(s) from users without write access.)

{{/omitted}}
You are on branch `{{branch}}` at {{head}}. Respond to @{{by}}'s latest message.
