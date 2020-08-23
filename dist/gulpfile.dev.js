"use strict";

var gulp = require('gulp');

var babel = require("gulp-babel");

var minify = require("gulp-uglify");

var rename = require("gulp-rename");

var sass = require("gulp-sass"); // JS


gulp.task('build', function () {
  return gulp.src('src/**/*.js').pipe(babel()).pipe(minify()).pipe(gulp.dest('dist'));
});