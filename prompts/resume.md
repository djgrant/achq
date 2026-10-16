New activity on issue #{{issue.number}} since your last run.

{{#bodyChanged}}
## The issue body has changed

{{issue.body}}

{{/bodyChanged}}
## New comments

{{#comments}}
### @{{author}} · {{date}}

{{body}}

{{/comments}}
{{#omitted}}
(Left out {{omitted}} comment(s) from users without write access.)

{{/omitted}}
You are on branch `{{branch}}` at {{head}}. Respond to @{{mentionedBy}}'s latest mention of you.
