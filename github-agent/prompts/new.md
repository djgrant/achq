You're working on issue #{{issue.number}}: {{issue.title}} ({{issue.url}}).

## Issue body

{{issue.body}}

## Comments

{{#comments}}
### @{{author}} · {{date}}

{{body}}

{{/comments}}
{{^comments}}
(none)

{{/comments}}
{{#omitted}}
(Left out {{omitted}} comment(s) from users without write access.)

{{/omitted}}
You are on branch `{{branch}}` at {{head}}. Respond to @{{mentionedBy}}'s latest mention of you.
