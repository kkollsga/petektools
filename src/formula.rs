//! Domain-free formula parsing and vectorized evaluation.
//!
//! The language is deliberately small: assignment blocks, scalar `$params`,
//! bare property variables, arithmetic/comparison operators, and a fixed set of
//! numeric functions. It knows nothing about grids, cells, wells, zones, or any
//! other caller domain.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use crate::{AlgoError, Result};

/// One parsed `lhs = rhs` formula assignment.
#[derive(Debug, Clone)]
pub struct Assignment {
    lhs: String,
    expr: Expr,
}

impl Assignment {
    /// Parse one assignment string such as
    /// `RQI = $lambda * sqrt(PermXY_BC / PorE_BC)`.
    pub fn parse(text: &str) -> Result<Self> {
        let (lhs, rhs) = split_assignment(text)?;
        if !is_ident(lhs) {
            return Err(AlgoError::Parse(format!(
                "invalid assignment lhs `{lhs}`: expected a bare identifier"
            )));
        }
        let tokens = tokenize(rhs)?;
        let mut parser = Parser::new(tokens);
        let expr = parser.parse_expression()?;
        parser.expect_end()?;
        Ok(Self {
            lhs: lhs.to_string(),
            expr,
        })
    }

    /// Name written by this assignment.
    pub fn lhs(&self) -> &str {
        &self.lhs
    }

    /// Scalar runtime parameters referenced by this assignment, without `$`.
    pub fn params(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        self.expr.collect_params(&mut out);
        out
    }

    /// Bare variable names referenced by this assignment.
    pub fn variables(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        self.expr.collect_vars(&mut out);
        out
    }
}

/// Parsed formula block with duplicate outputs/cycles already validated.
#[derive(Debug, Clone)]
pub struct FormulaBlock {
    assignments: Vec<Assignment>,
    order: Vec<usize>,
}

impl FormulaBlock {
    /// Parse and validate a block of assignment strings.
    pub fn parse<S: AsRef<str>>(lines: &[S]) -> Result<Self> {
        let assignments: Result<Vec<_>> = lines
            .iter()
            .map(|line| Assignment::parse(line.as_ref()))
            .collect();
        let assignments = assignments?;
        let order = evaluation_order(&assignments)?;
        Ok(Self { assignments, order })
    }

    /// The parsed assignments in source order.
    pub fn assignments(&self) -> &[Assignment] {
        &self.assignments
    }

    /// Assignment output names in source order.
    pub fn outputs(&self) -> Vec<String> {
        self.assignments.iter().map(|a| a.lhs.clone()).collect()
    }

    /// Assignment output names in evaluation order.
    pub fn evaluation_order(&self) -> Vec<String> {
        self.order
            .iter()
            .map(|&idx| self.assignments[idx].lhs.clone())
            .collect()
    }

    /// Scalar runtime parameters referenced by the block, without `$`.
    pub fn params(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for assignment in &self.assignments {
            out.extend(assignment.params());
        }
        out
    }

    /// External bare property variables referenced by the block.
    ///
    /// Bare names that are assigned inside the same block are assignment
    /// dependencies, not external properties.
    pub fn property_dependencies(&self) -> BTreeSet<String> {
        let outputs: BTreeSet<_> = self.assignments.iter().map(|a| a.lhs.clone()).collect();
        let mut out = BTreeSet::new();
        for assignment in &self.assignments {
            for var in assignment.variables() {
                if !outputs.contains(&var) {
                    out.insert(var);
                }
            }
        }
        out
    }

    /// Evaluate the block over named equal-length property arrays and scalar
    /// parameters.
    ///
    /// Scalars broadcast. The returned map contains only assignment outputs.
    /// Existing input properties are never modified.
    pub fn evaluate(
        &self,
        properties: &HashMap<String, Vec<f64>>,
        params: &HashMap<String, f64>,
    ) -> Result<HashMap<String, Vec<f64>>> {
        evaluate_assignments(&self.assignments, properties, params)
    }
}

/// Topologically order a set of parsed assignments.
pub fn evaluation_order(assignments: &[Assignment]) -> Result<Vec<usize>> {
    let mut by_lhs = BTreeMap::new();
    for (idx, assignment) in assignments.iter().enumerate() {
        if by_lhs.insert(assignment.lhs.clone(), idx).is_some() {
            return Err(AlgoError::InvalidArgument(format!(
                "duplicate assignment lhs `{}`",
                assignment.lhs
            )));
        }
    }

    let mut indegree = vec![0usize; assignments.len()];
    let mut dependents = vec![Vec::new(); assignments.len()];
    for (idx, assignment) in assignments.iter().enumerate() {
        for var in assignment.variables() {
            if let Some(&dep_idx) = by_lhs.get(&var) {
                indegree[idx] += 1;
                dependents[dep_idx].push(idx);
            }
        }
    }

    let mut ready: VecDeque<_> = indegree
        .iter()
        .enumerate()
        .filter_map(|(idx, &degree)| (degree == 0).then_some(idx))
        .collect();
    let mut order = Vec::with_capacity(assignments.len());
    while let Some(idx) = ready.pop_front() {
        order.push(idx);
        for &next in &dependents[idx] {
            indegree[next] -= 1;
            if indegree[next] == 0 {
                ready.push_back(next);
            }
        }
    }

    if order.len() != assignments.len() {
        let cyclic: Vec<_> = assignments
            .iter()
            .zip(indegree.iter())
            .filter_map(|(assignment, &degree)| (degree > 0).then_some(assignment.lhs.as_str()))
            .collect();
        return Err(AlgoError::InvalidArgument(format!(
            "cyclic formula dependencies involving {}",
            cyclic.join(", ")
        )));
    }
    Ok(order)
}

/// Parse and evaluate assignment strings in one call.
pub fn evaluate_formulas<S: AsRef<str>>(
    lines: &[S],
    properties: &HashMap<String, Vec<f64>>,
    params: &HashMap<String, f64>,
) -> Result<HashMap<String, Vec<f64>>> {
    FormulaBlock::parse(lines)?.evaluate(properties, params)
}

/// Evaluate parsed assignments over named equal-length property arrays and
/// scalar parameters.
pub fn evaluate_assignments(
    assignments: &[Assignment],
    properties: &HashMap<String, Vec<f64>>,
    params: &HashMap<String, f64>,
) -> Result<HashMap<String, Vec<f64>>> {
    let order = evaluation_order(assignments)?;
    let mut ctx = EvalContext {
        properties,
        params,
        values: HashMap::new(),
        len: None,
    };

    for &idx in &order {
        let assignment = &assignments[idx];
        let value = ctx.eval(&assignment.expr)?;
        ctx.values.insert(assignment.lhs.clone(), value);
    }

    let len = ctx.len.unwrap_or(1);
    let mut out = HashMap::with_capacity(assignments.len());
    for assignment in assignments {
        let value = ctx
            .values
            .get(&assignment.lhs)
            .expect("assignment was evaluated");
        out.insert(assignment.lhs.clone(), value.to_vec(len)?);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum Expr {
    Number(f64),
    Param(String),
    Var(String),
    Unary(UnaryOp, Box<Expr>),
    Binary(BinaryOp, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

impl Expr {
    fn collect_params(&self, out: &mut BTreeSet<String>) {
        match self {
            Expr::Param(name) => {
                out.insert(name.clone());
            }
            Expr::Unary(_, expr) => expr.collect_params(out),
            Expr::Binary(_, left, right) => {
                left.collect_params(out);
                right.collect_params(out);
            }
            Expr::Call(_, args) => {
                for arg in args {
                    arg.collect_params(out);
                }
            }
            Expr::Number(_) | Expr::Var(_) => {}
        }
    }

    fn collect_vars(&self, out: &mut BTreeSet<String>) {
        match self {
            Expr::Var(name) => {
                out.insert(name.clone());
            }
            Expr::Unary(_, expr) => expr.collect_vars(out),
            Expr::Binary(_, left, right) => {
                left.collect_vars(out);
                right.collect_vars(out);
            }
            Expr::Call(_, args) => {
                for arg in args {
                    arg.collect_vars(out);
                }
            }
            Expr::Number(_) | Expr::Param(_) => {}
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum UnaryOp {
    Pos,
    Neg,
}

#[derive(Debug, Clone, Copy)]
enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

struct EvalContext<'a> {
    properties: &'a HashMap<String, Vec<f64>>,
    params: &'a HashMap<String, f64>,
    values: HashMap<String, Value>,
    len: Option<usize>,
}

impl EvalContext<'_> {
    fn eval(&mut self, expr: &Expr) -> Result<Value> {
        match expr {
            Expr::Number(value) => Ok(Value::Scalar(*value)),
            Expr::Param(name) => {
                let value = *self
                    .params
                    .get(name)
                    .ok_or_else(|| AlgoError::NotFound(format!("formula parameter `${name}`")))?;
                if !value.is_finite() {
                    return Err(AlgoError::InvalidArgument(format!(
                        "formula parameter `${name}` is not finite"
                    )));
                }
                Ok(Value::Scalar(value))
            }
            Expr::Var(name) => {
                if let Some(value) = self.values.get(name).cloned() {
                    self.observe(&value)?;
                    return Ok(value);
                }
                let values = self
                    .properties
                    .get(name)
                    .ok_or_else(|| AlgoError::NotFound(format!("formula property `{name}`")))?;
                self.observe_len(values.len())?;
                Ok(Value::Array(values.clone()))
            }
            Expr::Unary(op, expr) => {
                let value = self.eval(expr)?;
                Ok(value.map(|x| match op {
                    UnaryOp::Pos => x,
                    UnaryOp::Neg => -x,
                }))
            }
            Expr::Binary(op, left, right) => {
                let left = self.eval(left)?;
                let right = self.eval(right)?;
                left.zip(&right, *op)
            }
            Expr::Call(name, args) => self.eval_call(name, args),
        }
    }

    fn eval_call(&mut self, name: &str, args: &[Expr]) -> Result<Value> {
        match name {
            "sqrt" | "log" | "log10" | "exp" | "abs" => {
                expect_arity(name, args, 1)?;
                let value = self.eval(&args[0])?;
                Ok(value.map(|x| match name {
                    "sqrt" => x.sqrt(),
                    "log" => x.ln(),
                    "log10" => x.log10(),
                    "exp" => x.exp(),
                    "abs" => x.abs(),
                    _ => unreachable!(),
                }))
            }
            "pow" | "min" | "max" => {
                expect_arity(name, args, 2)?;
                let left = self.eval(&args[0])?;
                let right = self.eval(&args[1])?;
                let op = match name {
                    "pow" => BinaryOp::Pow,
                    "min" => return left.zip_fn(&right, nan_propagating_min),
                    "max" => return left.zip_fn(&right, nan_propagating_max),
                    _ => unreachable!(),
                };
                left.zip(&right, op)
            }
            "clip" => {
                expect_arity(name, args, 3)?;
                let value = self.eval(&args[0])?;
                let lo = self.eval(&args[1])?;
                let hi = self.eval(&args[2])?;
                let clipped = value.zip_fn(&lo, |x, lo| {
                    if x.is_nan() || lo.is_nan() {
                        f64::NAN
                    } else {
                        x.max(lo)
                    }
                })?;
                clipped.zip_fn(&hi, |x, hi| {
                    if x.is_nan() || hi.is_nan() {
                        f64::NAN
                    } else {
                        x.min(hi)
                    }
                })
            }
            "if" => {
                expect_arity(name, args, 3)?;
                let cond = self.eval(&args[0])?;
                let yes = self.eval(&args[1])?;
                let no = self.eval(&args[2])?;
                cond.zip3_fn(&yes, &no, |c, y, n| if truthy(c) { y } else { n })
            }
            _ => Err(AlgoError::InvalidArgument(format!(
                "unsupported formula function `{name}`"
            ))),
        }
    }

    fn observe(&mut self, value: &Value) -> Result<()> {
        if let Value::Array(values) = value {
            self.observe_len(values.len())?;
        }
        Ok(())
    }

    fn observe_len(&mut self, len: usize) -> Result<()> {
        match self.len {
            Some(existing) if existing != len => Err(AlgoError::InvalidArgument(format!(
                "formula shape mismatch: expected length {existing}, got {len}"
            ))),
            Some(_) => Ok(()),
            None => {
                self.len = Some(len);
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone)]
enum Value {
    Scalar(f64),
    Array(Vec<f64>),
}

impl Value {
    fn map(self, f: impl Fn(f64) -> f64) -> Self {
        match self {
            Value::Scalar(value) => Value::Scalar(f(value)),
            Value::Array(values) => Value::Array(values.into_iter().map(f).collect()),
        }
    }

    fn zip(&self, other: &Self, op: BinaryOp) -> Result<Self> {
        self.zip_fn(other, |a, b| apply_binary(op, a, b))
    }

    fn zip_fn(&self, other: &Self, f: impl Fn(f64, f64) -> f64) -> Result<Self> {
        match (self, other) {
            (Value::Scalar(a), Value::Scalar(b)) => Ok(Value::Scalar(f(*a, *b))),
            (Value::Array(a), Value::Scalar(b)) => {
                Ok(Value::Array(a.iter().map(|&x| f(x, *b)).collect()))
            }
            (Value::Scalar(a), Value::Array(b)) => {
                Ok(Value::Array(b.iter().map(|&x| f(*a, x)).collect()))
            }
            (Value::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return Err(AlgoError::InvalidArgument(format!(
                        "formula shape mismatch: left length {}, right length {}",
                        a.len(),
                        b.len()
                    )));
                }
                Ok(Value::Array(
                    a.iter().zip(b.iter()).map(|(&x, &y)| f(x, y)).collect(),
                ))
            }
        }
    }

    fn zip3_fn(
        &self,
        second: &Self,
        third: &Self,
        f: impl Fn(f64, f64, f64) -> f64,
    ) -> Result<Self> {
        let len = [self.array_len(), second.array_len(), third.array_len()]
            .into_iter()
            .flatten()
            .try_fold(None::<usize>, |acc, n| match acc {
                Some(existing) if existing != n => Err(AlgoError::InvalidArgument(format!(
                    "formula shape mismatch: expected length {existing}, got {n}"
                ))),
                Some(existing) => Ok(Some(existing)),
                None => Ok(Some(n)),
            })?;
        match len {
            Some(n) => Ok(Value::Array(
                (0..n)
                    .map(|idx| f(self.at(idx), second.at(idx), third.at(idx)))
                    .collect(),
            )),
            None => match (self, second, third) {
                (Value::Scalar(a), Value::Scalar(b), Value::Scalar(c)) => {
                    Ok(Value::Scalar(f(*a, *b, *c)))
                }
                _ => unreachable!("array_len detected all array cases"),
            },
        }
    }

    fn array_len(&self) -> Option<usize> {
        match self {
            Value::Scalar(_) => None,
            Value::Array(values) => Some(values.len()),
        }
    }

    fn at(&self, idx: usize) -> f64 {
        match self {
            Value::Scalar(value) => *value,
            Value::Array(values) => values[idx],
        }
    }

    fn to_vec(&self, len: usize) -> Result<Vec<f64>> {
        match self {
            Value::Scalar(value) => Ok(vec![*value; len]),
            Value::Array(values) => {
                if values.len() != len {
                    return Err(AlgoError::InvalidArgument(format!(
                        "formula shape mismatch: expected length {len}, got {}",
                        values.len()
                    )));
                }
                Ok(values.clone())
            }
        }
    }
}

fn apply_binary(op: BinaryOp, a: f64, b: f64) -> f64 {
    match op {
        BinaryOp::Add => a + b,
        BinaryOp::Sub => a - b,
        BinaryOp::Mul => a * b,
        BinaryOp::Div => a / b,
        BinaryOp::Pow => a.powf(b),
        BinaryOp::Lt => bool_value(a < b),
        BinaryOp::Le => bool_value(a <= b),
        BinaryOp::Gt => bool_value(a > b),
        BinaryOp::Ge => bool_value(a >= b),
        BinaryOp::Eq => bool_value(a == b),
        BinaryOp::Ne => bool_value(a != b),
    }
}

fn bool_value(value: bool) -> f64 {
    if value {
        1.0
    } else {
        0.0
    }
}

fn truthy(value: f64) -> bool {
    value.is_finite() && value != 0.0
}

fn nan_propagating_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn nan_propagating_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn expect_arity(name: &str, args: &[Expr], expected: usize) -> Result<()> {
    if args.len() != expected {
        return Err(AlgoError::InvalidArgument(format!(
            "formula function `{name}` expects {expected} argument(s), got {}",
            args.len()
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Ident(String),
    Param(String),
    Plus,
    Minus,
    Star,
    Slash,
    Pow,
    LParen,
    RParen,
    Comma,
    Lt,
    Le,
    Gt,
    Ge,
    EqEq,
    Ne,
    End,
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(mut tokens: Vec<Token>) -> Self {
        tokens.push(Token::End);
        Self { tokens, pos: 0 }
    }

    fn parse_expression(&mut self) -> Result<Expr> {
        self.parse_comparison()
    }

    fn parse_comparison(&mut self) -> Result<Expr> {
        let mut expr = self.parse_additive()?;
        loop {
            let op = match self.peek() {
                Token::Lt => BinaryOp::Lt,
                Token::Le => BinaryOp::Le,
                Token::Gt => BinaryOp::Gt,
                Token::Ge => BinaryOp::Ge,
                Token::EqEq => BinaryOp::Eq,
                Token::Ne => BinaryOp::Ne,
                _ => break,
            };
            self.advance();
            let rhs = self.parse_additive()?;
            expr = Expr::Binary(op, Box::new(expr), Box::new(rhs));
        }
        Ok(expr)
    }

    fn parse_additive(&mut self) -> Result<Expr> {
        let mut expr = self.parse_multiplicative()?;
        loop {
            let op = match self.peek() {
                Token::Plus => BinaryOp::Add,
                Token::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.advance();
            let rhs = self.parse_multiplicative()?;
            expr = Expr::Binary(op, Box::new(expr), Box::new(rhs));
        }
        Ok(expr)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr> {
        let mut expr = self.parse_power()?;
        loop {
            let op = match self.peek() {
                Token::Star => BinaryOp::Mul,
                Token::Slash => BinaryOp::Div,
                _ => break,
            };
            self.advance();
            let rhs = self.parse_power()?;
            expr = Expr::Binary(op, Box::new(expr), Box::new(rhs));
        }
        Ok(expr)
    }

    fn parse_power(&mut self) -> Result<Expr> {
        let mut expr = self.parse_unary()?;
        if matches!(self.peek(), Token::Pow) {
            self.advance();
            let rhs = self.parse_power()?;
            expr = Expr::Binary(BinaryOp::Pow, Box::new(expr), Box::new(rhs));
        }
        Ok(expr)
    }

    fn parse_unary(&mut self) -> Result<Expr> {
        match self.peek() {
            Token::Plus => {
                self.advance();
                Ok(Expr::Unary(UnaryOp::Pos, Box::new(self.parse_unary()?)))
            }
            Token::Minus => {
                self.advance();
                Ok(Expr::Unary(UnaryOp::Neg, Box::new(self.parse_unary()?)))
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr> {
        match self.advance().clone() {
            Token::Number(value) => Ok(Expr::Number(value)),
            Token::Param(name) => Ok(Expr::Param(name)),
            Token::Ident(name) => {
                if matches!(self.peek(), Token::LParen) {
                    self.advance();
                    let args = self.parse_args()?;
                    Ok(Expr::Call(name, args))
                } else {
                    Ok(Expr::Var(name))
                }
            }
            Token::LParen => {
                let expr = self.parse_expression()?;
                self.expect(Token::RParen)?;
                Ok(expr)
            }
            token => Err(AlgoError::Parse(format!(
                "expected formula expression, got {token:?}"
            ))),
        }
    }

    fn parse_args(&mut self) -> Result<Vec<Expr>> {
        if matches!(self.peek(), Token::RParen) {
            self.advance();
            return Ok(Vec::new());
        }
        let mut args = Vec::new();
        loop {
            args.push(self.parse_expression()?);
            match self.peek() {
                Token::Comma => {
                    self.advance();
                }
                Token::RParen => {
                    self.advance();
                    return Ok(args);
                }
                token => {
                    return Err(AlgoError::Parse(format!(
                        "expected `,` or `)` in formula call, got {token:?}"
                    )));
                }
            }
        }
    }

    fn expect(&mut self, expected: Token) -> Result<()> {
        let got = self.advance().clone();
        if got != expected {
            return Err(AlgoError::Parse(format!(
                "expected {expected:?}, got {got:?}"
            )));
        }
        Ok(())
    }

    fn expect_end(&self) -> Result<()> {
        if !matches!(self.peek(), Token::End) {
            return Err(AlgoError::Parse(format!(
                "unexpected trailing formula token {:?}",
                self.peek()
            )));
        }
        Ok(())
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }

    fn advance(&mut self) -> &Token {
        let pos = self.pos;
        self.pos += 1;
        &self.tokens[pos]
    }
}

fn split_assignment(text: &str) -> Result<(&str, &str)> {
    let bytes = text.as_bytes();
    for (idx, &byte) in bytes.iter().enumerate() {
        if byte != b'=' {
            continue;
        }
        let prev = idx.checked_sub(1).map(|i| bytes[i]);
        let next = bytes.get(idx + 1).copied();
        if matches!(prev, Some(b'<' | b'>' | b'!' | b'=')) || matches!(next, Some(b'=')) {
            continue;
        }
        let lhs = text[..idx].trim();
        let rhs = text[idx + 1..].trim();
        if lhs.is_empty() || rhs.is_empty() {
            return Err(AlgoError::Parse(
                "formula assignment requires non-empty lhs and rhs".to_string(),
            ));
        }
        return Ok((lhs, rhs));
    }
    Err(AlgoError::Parse(format!(
        "formula assignment missing `=`: {text}"
    )))
}

fn tokenize(text: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '+' => {
                tokens.push(Token::Plus);
                i += 1;
            }
            '-' => {
                tokens.push(Token::Minus);
                i += 1;
            }
            '*' => {
                if chars.get(i + 1) == Some(&'*') {
                    tokens.push(Token::Pow);
                    i += 2;
                } else {
                    tokens.push(Token::Star);
                    i += 1;
                }
            }
            '/' => {
                tokens.push(Token::Slash);
                i += 1;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
            }
            '<' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(Token::Le);
                    i += 2;
                } else {
                    tokens.push(Token::Lt);
                    i += 1;
                }
            }
            '>' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(Token::Ge);
                    i += 2;
                } else {
                    tokens.push(Token::Gt);
                    i += 1;
                }
            }
            '=' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(Token::EqEq);
                    i += 2;
                } else {
                    return Err(AlgoError::Parse(
                        "unexpected `=` inside formula expression; use `==` for equality"
                            .to_string(),
                    ));
                }
            }
            '!' => {
                if chars.get(i + 1) == Some(&'=') {
                    tokens.push(Token::Ne);
                    i += 2;
                } else {
                    return Err(AlgoError::Parse(
                        "unexpected `!` inside formula expression; use `!=` for inequality"
                            .to_string(),
                    ));
                }
            }
            '$' => {
                let (name, next) = read_ident(&chars, i + 1)?;
                tokens.push(Token::Param(name));
                i = next;
            }
            _ if c.is_ascii_digit() || c == '.' => {
                let (value, next) = read_number(&chars, i)?;
                tokens.push(Token::Number(value));
                i = next;
            }
            _ if is_ident_start(c) => {
                let (name, next) = read_ident(&chars, i)?;
                tokens.push(Token::Ident(name));
                i = next;
            }
            _ => {
                return Err(AlgoError::Parse(format!(
                    "unexpected character `{c}` in formula expression"
                )));
            }
        }
    }
    Ok(tokens)
}

fn read_number(chars: &[char], start: usize) -> Result<(f64, usize)> {
    let mut end = start;
    let mut saw_digit = false;
    while end < chars.len() && chars[end].is_ascii_digit() {
        saw_digit = true;
        end += 1;
    }
    if chars.get(end) == Some(&'.') {
        end += 1;
        while end < chars.len() && chars[end].is_ascii_digit() {
            saw_digit = true;
            end += 1;
        }
    }
    if !saw_digit {
        return Err(AlgoError::Parse(
            "expected digit in formula number literal".to_string(),
        ));
    }
    if matches!(chars.get(end), Some('e' | 'E')) {
        end += 1;
        if matches!(chars.get(end), Some('+' | '-')) {
            end += 1;
        }
        let exp_digits = end;
        while end < chars.len() && chars[end].is_ascii_digit() {
            end += 1;
        }
        if end == exp_digits {
            return Err(AlgoError::Parse(
                "invalid exponent in formula number literal".to_string(),
            ));
        }
    }
    chars[start..end]
        .iter()
        .collect::<String>()
        .parse::<f64>()
        .map(|value| (value, end))
        .map_err(|e| AlgoError::Parse(format!("invalid formula number literal: {e}")))
}

fn read_ident(chars: &[char], start: usize) -> Result<(String, usize)> {
    if !matches!(chars.get(start), Some(&c) if is_ident_start(c)) {
        return Err(AlgoError::Parse(
            "expected identifier in formula expression".to_string(),
        ));
    }
    let mut end = start + 1;
    while matches!(chars.get(end), Some(&c) if is_ident_continue(c)) {
        end += 1;
    }
    Ok((chars[start..end].iter().collect(), end))
}

fn is_ident(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if is_ident_start(c)) && chars.all(is_ident_continue)
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_continue(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(values: &[(&str, Vec<f64>)]) -> HashMap<String, Vec<f64>> {
        values
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    fn params(values: &[(&str, f64)]) -> HashMap<String, f64> {
        values.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    #[test]
    fn parses_dependencies() {
        let block = FormulaBlock::parse(&[
            "RQI = $lambda * sqrt(PermXY_BC / PorE_BC)",
            "Swirr = pow(RQI, $d)",
        ])
        .unwrap();
        assert_eq!(block.outputs(), vec!["RQI", "Swirr"]);
        assert_eq!(
            block.params(),
            BTreeSet::from(["d".to_string(), "lambda".to_string()])
        );
        assert_eq!(
            block.property_dependencies(),
            BTreeSet::from(["PermXY_BC".to_string(), "PorE_BC".to_string()])
        );
        assert_eq!(block.evaluation_order(), vec!["RQI", "Swirr"]);
    }

    #[test]
    fn evaluates_if_and_comparisons() {
        let block = FormulaBlock::parse(&["Sw = if(HA_FWL == 0, 1, Swirr + $a)"]).unwrap();
        let out = block
            .evaluate(
                &map(&[
                    ("HA_FWL", vec![0.0, 10.0, 0.0]),
                    ("Swirr", vec![0.2, 0.3, 0.4]),
                ]),
                &params(&[("a", 0.5)]),
            )
            .unwrap();
        assert_eq!(out["Sw"], vec![1.0, 0.8, 1.0]);
    }
}
